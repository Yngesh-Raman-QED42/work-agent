import { eq } from 'drizzle-orm';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { AnyDb } from '../../db/index.js';
import { executionTasks } from '../../db/schema.js';
import type { WorkAgentConfig } from '../../config/index.js';
import { AuditLog } from '../../pipeline/audit.js';
import { ApprovalsStore } from '../../shared/approvals.js';
import { evaluateGate, type GateConfig } from './gate.js';
import { runChecks, DEFAULT_COMMANDS } from './checks.js';
import type { ClaudeCodeRunner, RunOutcome } from './claudeRunner.js';
import type { GitOps, AssetFile } from './gitOps.js';
import type { ExecutionResult, RepoInfo, TaskContext } from './models.js';
import { repoFullName } from './models.js';
import type { PullRequestCreator } from './prOps.js';
import { buildImplementationPrompt } from './prompt.js';
import type { AutonomyPolicy } from './policy.js';
import { resolveRepo } from './repoResolver.js';
import { selectTask } from './selector.js';
import { WorktreeManager, materializeRealNodeModules } from './worktree.js';
import { formatMinutes } from '../workLog/timeEntry.js';
import type { JiraIssueUpdater } from '../../integrations/jira/issueUpdater.js';
import {
  PlaywrightScreenshotCapture,
  readScreenshotSteps,
  cleanupScreenshotSteps,
  resolvePreviewRecipe,
  SCREENSHOT_OUTPUT_DIR,
  type ScreenshotCapture,
  type CapturedScreenshot,
} from './screenshot.js';

// Every real Jira project names its own workflow statuses differently, so
// these are candidates tried in order via JiraIssueUpdater.transitionToStatus
// — whichever one the issue's live workflow actually offers right now wins;
// none of them is ever forced onto a workflow that doesn't have it.
export const IN_PROGRESS_STATUS_CANDIDATES = ['In Progress', 'In Development', 'Development', 'Doing'];
export const IN_REVIEW_STATUS_CANDIDATES = ['In Review', 'Code Review', 'Ready For Review', 'Review', 'Peer Review'];

async function upsertTask(db: AnyDb, id: string, fields: Partial<typeof executionTasks.$inferInsert>): Promise<void> {
  const existing = await db.select().from(executionTasks).where(eq(executionTasks.id, id));
  const now = new Date();
  if (existing.length === 0) {
    await db.insert(executionTasks).values({
      id,
      repo: '',
      status: 'selected',
      createdAt: now,
      updatedAt: now,
      ...fields,
    } as typeof executionTasks.$inferInsert);
  } else {
    await db.update(executionTasks).set({ ...fields, updatedAt: now }).where(eq(executionTasks.id, id));
  }
}

// ---------------------------------------------------------------------------
// Part 1: everything up to "here's the prompt, go implement it." Entirely
// deterministic — no live agent needed for any of this.
// ---------------------------------------------------------------------------

export interface StartExecutionDeps {
  db: AnyDb;
  config: WorkAgentConfig;
  candidates: TaskContext[];
  policy: AutonomyPolicy;
  hasExistingPr?: (key: string) => boolean;
  worktreeManagerFactory?: (localPath: string) => WorktreeManager;
  // A factory, not an instance — mirrors getWorklogWriter in cli.ts: a live
  // updater throws in its constructor without real Jira creds, so it's
  // only ever constructed when there's an issue to actually update.
  getIssueUpdater?: () => JiraIssueUpdater;
}

export type StartExecutionStatus = 'started' | 'stopped_ambiguous' | 'no_eligible_task';

export interface StartExecutionResult {
  status: StartExecutionStatus;
  task?: TaskContext;
  repo?: RepoInfo;
  worktreePath?: string;
  prompt?: string;
  startedAt?: Date;
  reasons: string[];
}

export async function startExecution(deps: StartExecutionDeps): Promise<StartExecutionResult> {
  const { db, config, candidates, policy } = deps;
  const hasExistingPr = deps.hasExistingPr ?? (() => false);
  const audit = new AuditLog(db);
  const approvals = new ApprovalsStore(db);

  await audit.log('execution_run_started', { candidate_count: candidates.length });

  const selection = selectTask(candidates, policy, hasExistingPr);
  await audit.log('execution_candidates_evaluated', {
    evaluations: selection.evaluations.map((e) => ({ key: e.task.key, eligible: e.eligible, reasons: e.reasons })),
  });

  if (!selection.picked) {
    await audit.log('execution_no_eligible_task', {});
    return { status: 'no_eligible_task', reasons: ['no candidate satisfied the autonomy policy'] };
  }

  const task = selection.picked;
  const startedAt = new Date();
  await audit.log('execution_task_selected', { key: task.key, summary: task.summary });
  await upsertTask(db, task.key, { jiraKey: task.key, status: 'selected' });

  const repo = resolveRepo(config, task.project);
  if (!repo) {
    const reason = `no approved/mapped repository found for project ${task.project}`;
    await approvals.file({
      id: `exec-ambiguous:${task.key}`,
      source: 'engineering_execution',
      action: 'manual_review_no_repo_mapping',
      target: task.key,
      targetUrl: task.url,
      context: { task },
      reasoning: reason,
      riskLevel: 'low',
      consequenceIfApproved: 'Nothing automated happens until you add a repoMap entry in work-agent.config.json.',
      recommendedAction: `Add ${task.project} to github.repoMap in work-agent.config.json, or handle ${task.key} manually.`,
    });
    await audit.log('execution_stopped_ambiguous', { key: task.key, reason });
    await upsertTask(db, task.key, { status: 'failed' });
    return { status: 'stopped_ambiguous', task, reasons: [reason] };
  }

  const wtManager = deps.worktreeManagerFactory ? deps.worktreeManagerFactory(repo.localPath) : new WorktreeManager(repo.localPath);
  const worktreePath = await wtManager.create(task.key.toLowerCase(), repo.defaultBranch);
  await audit.log('execution_worktree_created', { path: worktreePath, base_branch: repo.defaultBranch });
  await upsertTask(db, task.key, { repo: repoFullName(repo), worktreePath, status: 'implementing' });

  // Best-effort, same as the screenshot step: real work is genuinely
  // starting now, so the ticket should say so — but a Jira hiccup here
  // must never stop the worktree that's already been created.
  if (deps.getIssueUpdater) {
    try {
      const movedTo = await deps.getIssueUpdater().transitionToStatus(task.key, IN_PROGRESS_STATUS_CANDIDATES);
      await audit.log('execution_status_transitioned', { key: task.key, to: movedTo });
    } catch (err) {
      await audit.log('execution_status_transition_failed', { key: task.key, stage: 'start', error: String(err) });
    }
  }

  const previewRecipe = await resolvePreviewRecipe(config.github.previewRecipes[repoFullName(repo)], repo.localPath);
  const prompt = buildImplementationPrompt(task, worktreePath, previewRecipe);

  return { status: 'started', task, repo, worktreePath, prompt, startedAt, reasons: [] };
}

// ---------------------------------------------------------------------------
// Part 2: everything after the implementer reports back. Also entirely
// deterministic — verify, gate, optional screenshot, branch/commit/push,
// draft PR, real-elapsed-time approval. No live agent needed for any of
// this either; only the implementation step in between the two parts does.
// ---------------------------------------------------------------------------

export interface FinishExecutionDeps {
  db: AnyDb;
  config: WorkAgentConfig;
  task: TaskContext;
  repo: RepoInfo;
  worktreePath: string;
  startedAt: Date;
  outcome: RunOutcome;
  gitOps: GitOps;
  prCreator: PullRequestCreator;
  gateConfig?: GateConfig;
  checkCommands?: Array<[string, string[]]>;
  // Test seam — production always uses runChecks' own default (2 retries).
  // A real failure still reports failed after using all of them; this only
  // lets a test that deliberately fails a check skip the retry delay.
  checkRetries?: number;
  screenshotCapture?: ScreenshotCapture;
  getIssueUpdater?: () => JiraIssueUpdater;
}

export async function finishExecution(deps: FinishExecutionDeps): Promise<ExecutionResult> {
  const { db, config, task, repo, worktreePath, startedAt, outcome, gitOps, prCreator } = deps;
  const audit = new AuditLog(db);
  const approvals = new ApprovalsStore(db);

  await audit.log('execution_implementation_finished', { success: outcome.success, summary: outcome.summary });

  if (!outcome.success) {
    await approvals.file({
      id: `exec-ambiguous:${task.key}`,
      source: 'engineering_execution',
      action: 'manual_review_implementation_stopped',
      target: task.key,
      targetUrl: task.url,
      context: { task, summary: outcome.summary },
      reasoning: outcome.summary,
      riskLevel: 'medium',
      consequenceIfApproved: 'Nothing automated happens — this just surfaces that the implementer stopped itself.',
      recommendedAction: `Read the implementer's explanation and decide how to proceed with ${task.key} manually.`,
    });
    await audit.log('execution_stopped_ambiguous', { key: task.key, reason: outcome.summary });
    await upsertTask(db, task.key, { status: 'failed' });
    return { status: 'stopped_ambiguous', task, checks: [], reasons: [outcome.summary], worktreePath };
  }

  const checks = await runChecks(worktreePath, deps.checkCommands ?? DEFAULT_COMMANDS, undefined, deps.checkRetries);
  await audit.log('execution_checks_run', { results: checks.map((c) => ({ name: c.name, passed: c.passed })) });
  await upsertTask(db, task.key, { status: 'checking', validationStatus: checks });

  const diffStat = await gitOps.diffStat(worktreePath, `origin/${repo.defaultBranch}`);
  const gateDecision = evaluateGate(checks, diffStat, deps.gateConfig);
  await audit.log('execution_gate_decision', { proceed: gateDecision.proceed, reasons: gateDecision.reasons });

  if (!gateDecision.proceed) {
    await approvals.file({
      id: `exec-failed-checks:${task.key}`,
      source: 'engineering_execution',
      action: 'manual_review_failed_gate',
      target: task.key,
      targetUrl: task.url,
      context: { task, checks, diffStat },
      reasoning: gateDecision.reasons.join('; '),
      riskLevel: 'medium',
      consequenceIfApproved: 'Nothing automated happens — the change stays uncommitted in the worktree for manual review.',
      recommendedAction: `Inspect the worktree at ${worktreePath} and either fix it manually or discard it.`,
    });
    await audit.log('execution_stopped_failed_checks', { key: task.key, reasons: gateDecision.reasons });
    await upsertTask(db, task.key, { status: 'gated_stop' });
    return { status: 'stopped_failed_checks', task, checks, reasons: gateDecision.reasons, diffStat, worktreePath };
  }

  // Optional, best-effort, and skipped only if this repo explicitly opted
  // out — a failure here must never block the PR, since a screenshot is a
  // nice-to-have, never something the checks/gate above should be judged
  // against.
  let screenshots: CapturedScreenshot[] = [];
  let gifPath: string | undefined;
  let assetUrls: Record<string, string> = {}; // filename -> hosted raw URL
  // Surfaced in the CLI output (see cli.ts) — a screenshot failure must
  // never block the PR, but it must not be silently invisible either.
  let screenshotError: string | undefined;
  const previewRecipe = await resolvePreviewRecipe(config.github.previewRecipes[repoFullName(repo)], repo.localPath);
  if (previewRecipe) {
    const steps = await readScreenshotSteps(worktreePath);
    if (steps) {
      try {
        const capture = deps.screenshotCapture ?? new PlaywrightScreenshotCapture();
        if (capture instanceof PlaywrightScreenshotCapture) {
          // Only for the real Playwright capture — cli.ts passes one of
          // these explicitly (it's not just the `??` fallback), so this
          // has to check what capture actually IS, not whether the caller
          // bothered to pass one. See materializeRealNodeModules' own doc
          // for why a dev server needs this even though every check above
          // just ran fine without it.
          await materializeRealNodeModules(worktreePath);
        }
        const result = await capture.capture(worktreePath, previewRecipe, steps);
        screenshots = result.screenshots;
        gifPath = result.gifPath;
        await audit.log('execution_screenshots_captured', { key: task.key, count: screenshots.length, gif: !!gifPath });

        // Publish to a standalone assets branch — via git plumbing, so this
        // never touches the code branch's own commit history — then delete
        // the local files so the code commit below can never pick them up.
        // The screenshot belongs in the PR *description*, not the PR *diff*.
        const files: AssetFile[] = [
          ...screenshots.map((s) => ({ path: path.join(worktreePath, s.relativePath), name: path.basename(s.relativePath) })),
          ...(gifPath ? [{ path: path.join(worktreePath, gifPath), name: path.basename(gifPath) }] : []),
        ];
        if (files.length > 0) {
          const assetsBranch = `work-agent/screenshots/${task.key.toLowerCase()}`;
          try {
            await gitOps.publishAssetBranch(worktreePath, assetsBranch, files);
            const rawBase = `https://raw.githubusercontent.com/${repoFullName(repo)}/${assetsBranch}`;
            assetUrls = Object.fromEntries(files.map((f) => [f.name, `${rawBase}/${f.name}`]));
            await audit.log('execution_screenshot_assets_published', { key: task.key, branch: assetsBranch, count: files.length });
          } catch (err) {
            // Publishing failed — screenshots simply won't appear in the PR
            // body. They must still never end up committed to the code
            // branch, so the cleanup below runs regardless.
            screenshotError = `captured but failed to publish to the assets branch: ${String(err)}`;
            await audit.log('execution_screenshot_assets_failed', { key: task.key, error: String(err) });
          }
        }
      } catch (err) {
        screenshotError = String(err);
        await audit.log('execution_screenshots_failed', { key: task.key, error: String(err) });
      }
    }
    await cleanupScreenshotSteps(worktreePath);
    // Never let captured images ride along in the code PR's own diff — they
    // live only on the assets branch (or nowhere, if publishing failed).
    await rm(path.join(worktreePath, SCREENSHOT_OUTPUT_DIR), { recursive: true, force: true });
  }

  const branchName = `work-agent/${task.key.toLowerCase()}`;
  await gitOps.createBranch(worktreePath, branchName);
  const commitMessage = `${task.key}: ${task.summary}\n\n${outcome.summary}\n\nCo-Authored-By: Work Agent <work-agent@local>`;
  const committed = await gitOps.commitAll(worktreePath, commitMessage);
  if (!committed) {
    const reason = 'implementation reported success but produced no file changes';
    await approvals.file({
      id: `exec-empty-diff:${task.key}`,
      source: 'engineering_execution',
      action: 'manual_review_empty_diff',
      target: task.key,
      targetUrl: task.url,
      context: { task },
      reasoning: reason,
      riskLevel: 'medium',
      consequenceIfApproved: 'Nothing automated happens.',
      recommendedAction: `Investigate why ${task.key}'s implementation produced no diff.`,
    });
    await audit.log('execution_stopped_ambiguous', { key: task.key, reason });
    await upsertTask(db, task.key, { status: 'failed' });
    return { status: 'stopped_ambiguous', task, checks, reasons: [reason], worktreePath };
  }

  await gitOps.push(worktreePath, branchName);
  await audit.log('execution_pushed', { branch: branchName });
  await upsertTask(db, task.key, { branch: branchName, status: 'monitoring' });

  const checksLine = checks.map((c) => `${c.name}=${c.passed ? 'pass' : 'FAIL'}`).join(', ');
  const gifUrl = gifPath ? assetUrls[path.basename(gifPath)] : undefined;
  const gifBlock = gifUrl ? `\n\n**Feature in action:**\n\n![feature in action](${gifUrl})\n` : '';
  const screenshotsWithUrls = screenshots.filter((s) => assetUrls[path.basename(s.relativePath)]);
  const screenshotsBlock =
    screenshotsWithUrls.length > 0
      ? `\n\n**Screenshots:**\n\n${screenshotsWithUrls.map((s) => `${s.label}\n\n![${s.label}](${assetUrls[path.basename(s.relativePath)]})`).join('\n\n')}\n`
      : '';
  const asDraft = config.engineeringExecution.openPrAsDraft;
  const prBody =
    `Autonomous implementation of [${task.key}](${task.url}).\n\n` +
    `**Summary of changes:** ${outcome.summary}\n\n` +
    `**Checks:** ${checksLine}\n` +
    gifBlock +
    screenshotsBlock +
    `\n_Opened${asDraft ? ' as a draft' : ''} by the Work Agent — no merge, no deploy, review required before anything further happens._`;
  const prUrl = await prCreator.createPr(repo, branchName, `${task.key}: ${task.summary}`, prBody, asDraft);
  await audit.log('execution_pr_opened', { url: prUrl });
  await upsertTask(db, task.key, { prUrl });

  // Best-effort, same as the screenshot step and the start-of-work status
  // move above — the PR is already open regardless of whether either of
  // these succeeds, so a Jira hiccup here must never undo or block it.
  if (deps.getIssueUpdater) {
    const updater = deps.getIssueUpdater();
    try {
      await updater.addComment(task.key, `Work Agent implemented this: ${outcome.summary}`, [
        { label: `PR: ${task.key}: ${task.summary}`, url: prUrl },
      ]);
      await audit.log('execution_jira_comment_posted', { key: task.key });
    } catch (err) {
      await audit.log('execution_jira_comment_failed', { key: task.key, error: String(err) });
    }
    try {
      const movedTo = await updater.transitionToStatus(task.key, IN_REVIEW_STATUS_CANDIDATES);
      await audit.log('execution_status_transitioned', { key: task.key, to: movedTo });
    } catch (err) {
      await audit.log('execution_status_transition_failed', { key: task.key, stage: 'finish', error: String(err) });
    }
  }

  // Real elapsed wall-clock time, from task selection to draft PR — never
  // an estimate. Logging it to Jira is still gated behind your approval:
  // this only files the request, it never posts on its own.
  const elapsedMinutes = Math.max(1, Math.round((Date.now() - startedAt.getTime()) / 60_000));
  await new ApprovalsStore(db).file({
    id: `exec-log-time:${task.key}`,
    source: 'engineering_execution',
    action: 'log_execution_time',
    target: task.key,
    targetUrl: task.url,
    context: { taskKey: task.key, minutes: elapsedMinutes, taskSummary: task.summary, workSummary: outcome.summary, prUrl },
    reasoning: `Work Agent spent ${formatMinutes(elapsedMinutes)} autonomously implementing this ticket (worktree creation through draft PR) — real elapsed time, not an estimate.`,
    riskLevel: 'low',
    consequenceIfApproved: `Logs ${formatMinutes(elapsedMinutes)} as a real Jira worklog on ${task.key}, visible on your timesheet.`,
    recommendedAction: 'Approve to log this time on Jira, or reject if you\'d rather log it yourself.',
  });
  await audit.log('execution_time_pending_approval', { key: task.key, minutes: elapsedMinutes });

  return {
    status: 'opened_pr',
    task,
    branch: branchName,
    prUrl,
    checks,
    diffStat,
    worktreePath,
    reasons: gateDecision.reasons,
    screenshots,
    gifPath,
    screenshotError,
  };
}

// ---------------------------------------------------------------------------
// The original one-call entry point — kept working exactly as before for
// anything that already has a real, live ClaudeCodeRunner to inject (tests,
// the orchestrator). This is just startExecution -> claudeRunner.run() ->
// finishExecution wired together; it's not a different code path.
// ---------------------------------------------------------------------------

export interface RunExecutionDeps extends StartExecutionDeps {
  claudeRunner: ClaudeCodeRunner;
  gitOps: GitOps;
  prCreator: PullRequestCreator;
  gateConfig?: GateConfig;
  checkCommands?: Array<[string, string[]]>;
  checkRetries?: number;
  // Test seam only — production code lets each run construct its own real
  // PlaywrightScreenshotCapture.
  screenshotCapture?: ScreenshotCapture;
}

export async function runExecution(deps: RunExecutionDeps): Promise<ExecutionResult> {
  const started = await startExecution(deps);
  if (started.status !== 'started') {
    return { status: started.status, task: started.task, checks: [], reasons: started.reasons };
  }

  const outcome = await deps.claudeRunner.run(started.worktreePath!, started.prompt!);

  return finishExecution({
    db: deps.db,
    config: deps.config,
    task: started.task!,
    repo: started.repo!,
    worktreePath: started.worktreePath!,
    startedAt: started.startedAt!,
    outcome,
    gitOps: deps.gitOps,
    prCreator: deps.prCreator,
    gateConfig: deps.gateConfig,
    checkCommands: deps.checkCommands,
    checkRetries: deps.checkRetries,
    screenshotCapture: deps.screenshotCapture,
    getIssueUpdater: deps.getIssueUpdater,
  });
}
