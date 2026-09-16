import { eq } from 'drizzle-orm';
import type { AnyDb } from '../../db/index.js';
import { executionTasks } from '../../db/schema.js';
import type { WorkAgentConfig } from '../../config/index.js';
import { AuditLog } from '../../pipeline/audit.js';
import { ApprovalsStore } from '../../shared/approvals.js';
import { evaluateGate, type GateConfig } from './gate.js';
import { runChecks, DEFAULT_COMMANDS } from './checks.js';
import type { ClaudeCodeRunner } from './claudeRunner.js';
import type { GitOps } from './gitOps.js';
import type { ExecutionResult, TaskContext } from './models.js';
import { repoFullName } from './models.js';
import type { PullRequestCreator } from './prOps.js';
import { buildImplementationPrompt } from './prompt.js';
import type { AutonomyPolicy } from './policy.js';
import { resolveRepo } from './repoResolver.js';
import { selectTask } from './selector.js';
import { WorktreeManager } from './worktree.js';
import { formatMinutes } from '../workLog/timeEntry.js';
import {
  PlaywrightScreenshotCapture,
  readScreenshotSteps,
  cleanupScreenshotSteps,
  resolvePreviewRecipe,
  type ScreenshotCapture,
  type CapturedScreenshot,
} from './screenshot.js';

export interface RunExecutionDeps {
  db: AnyDb;
  config: WorkAgentConfig;
  candidates: TaskContext[];
  policy: AutonomyPolicy;
  claudeRunner: ClaudeCodeRunner;
  gitOps: GitOps;
  prCreator: PullRequestCreator;
  hasExistingPr?: (key: string) => boolean;
  worktreeManagerFactory?: (localPath: string) => WorktreeManager;
  gateConfig?: GateConfig;
  checkCommands?: Array<[string, string[]]>;
  // Test seam only — production code lets each run construct its own real
  // PlaywrightScreenshotCapture.
  screenshotCapture?: ScreenshotCapture;
}

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

export async function runExecution(deps: RunExecutionDeps): Promise<ExecutionResult> {
  const { db, config, candidates, policy, claudeRunner, gitOps, prCreator } = deps;
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
    return { status: 'no_eligible_task', checks: [], reasons: ['no candidate satisfied the autonomy policy'] };
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
    return { status: 'stopped_ambiguous', task, checks: [], reasons: [reason] };
  }

  const wtManager = deps.worktreeManagerFactory ? deps.worktreeManagerFactory(repo.localPath) : new WorktreeManager(repo.localPath);
  const worktreePath = await wtManager.create(task.key.toLowerCase(), repo.defaultBranch);
  await audit.log('execution_worktree_created', { path: worktreePath, base_branch: repo.defaultBranch });
  await upsertTask(db, task.key, { repo: repoFullName(repo), worktreePath, status: 'implementing' });

  const previewRecipe = await resolvePreviewRecipe(config.github.previewRecipes[repoFullName(repo)], repo.localPath);
  const prompt = buildImplementationPrompt(task, worktreePath, previewRecipe);
  const outcome = await claudeRunner.run(worktreePath, prompt);
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

  const checks = await runChecks(worktreePath, deps.checkCommands ?? DEFAULT_COMMANDS);
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
  if (previewRecipe) {
    const steps = await readScreenshotSteps(worktreePath);
    if (steps) {
      try {
        const capture = deps.screenshotCapture ?? new PlaywrightScreenshotCapture();
        const result = await capture.capture(worktreePath, previewRecipe, steps);
        screenshots = result.screenshots;
        gifPath = result.gifPath;
        await audit.log('execution_screenshots_captured', { key: task.key, count: screenshots.length, gif: !!gifPath });
      } catch (err) {
        await audit.log('execution_screenshots_failed', { key: task.key, error: String(err) });
      }
    }
    await cleanupScreenshotSteps(worktreePath);
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
  const gifBlock = gifPath ? `\n\n**Feature in action:**\n\n![feature in action](${gifPath})\n` : '';
  const screenshotsBlock =
    screenshots.length > 0
      ? `\n\n**Screenshots:**\n\n${screenshots.map((s) => `${s.label}\n\n![${s.label}](${s.relativePath})`).join('\n\n')}\n`
      : '';
  const prBody =
    `Autonomous implementation of [${task.key}](${task.url}).\n\n` +
    `**Summary of changes:** ${outcome.summary}\n\n` +
    `**Checks:** ${checksLine}\n` +
    gifBlock +
    screenshotsBlock +
    '\n_Opened as a draft by the Work Agent — no merge, no deploy, review required before anything further happens._';
  const prUrl = await prCreator.createDraftPr(repo, branchName, `${task.key}: ${task.summary}`, prBody);
  await audit.log('execution_pr_opened', { url: prUrl });
  await upsertTask(db, task.key, { prUrl });

  // Real elapsed wall-clock time, from task selection to draft PR — never
  // an estimate. Logging it to Jira is still gated behind your approval:
  // this only files the request, it never posts on its own.
  const elapsedMinutes = Math.max(1, Math.round((Date.now() - startedAt.getTime()) / 60_000));
  await approvals.file({
    id: `exec-log-time:${task.key}`,
    source: 'engineering_execution',
    action: 'log_execution_time',
    target: task.key,
    targetUrl: task.url,
    context: { taskKey: task.key, minutes: elapsedMinutes },
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
  };
}
