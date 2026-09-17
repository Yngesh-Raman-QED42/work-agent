import type { AnyDb } from '../../db/index.js';
import { AuditLog } from '../../pipeline/audit.js';
import { ApprovalsStore } from '../../shared/approvals.js';
import { runChecks, DEFAULT_COMMANDS } from '../engineeringExecution/checks.js';
import { evaluateGate, type GateConfig } from '../engineeringExecution/gate.js';
import type { ClaudeCodeRunner } from '../engineeringExecution/claudeRunner.js';
import type { GitOps } from '../engineeringExecution/gitOps.js';
import { WorktreeManager } from '../engineeringExecution/worktree.js';
import { classifyAll } from './feedbackClassifier.js';
import type { FeedbackClassification, MonitorResult, PrStatus } from './models.js';
import type { PrStatusReader } from './githubReader.js';

export interface MonitorPrDeps {
  db: AnyDb;
  repo: string; // "owner/repo"
  number: number;
  reader: PrStatusReader;
  claudeRunner: ClaudeCodeRunner;
  gitOps: GitOps;
  worktreeManagerFactory?: () => WorktreeManager;
  repoLocalPath: string;
  gateConfig?: GateConfig;
  checkCommands?: Array<[string, string[]]>;
  checkRetries?: number;
}

function summarizeFeedback(escalations: FeedbackClassification[]): string {
  return escalations.map((e) => `- ${e.comment.author}: "${e.comment.body.slice(0, 200)}" (${e.reasons.join('; ')})`).join('\n');
}

function buildRecommendedResponse(pr: PrStatus, escalations: FeedbackClassification[]): string {
  return (
    `Review feedback on ${pr.repo}#${pr.number} needs your judgment before anything is implemented:\n\n` +
    summarizeFeedback(escalations) +
    '\n\nA proposed response/plan should address each point above; none of it has been auto-implemented.'
  );
}

export async function monitorPr(deps: MonitorPrDeps): Promise<MonitorResult> {
  const audit = new AuditLog(deps.db);
  const approvals = new ApprovalsStore(deps.db);

  await audit.log('pr_monitor_started', { repo: deps.repo, number: deps.number });

  const pr = await deps.reader.fetchPrStatus(deps.repo, deps.number);
  await audit.log('pr_monitor_fetched_status', {
    state: pr.state,
    review_state: pr.reviewState,
    ci_status: pr.ciStatus,
    comment_count: pr.comments.length,
  });

  if (pr.state !== 'open') {
    await audit.log('pr_monitor_no_action', { reason: 'PR is not open' });
    return { outcome: 'no_action_needed', pr, reasons: ['PR is not open'] };
  }

  const classifications = classifyAll(pr.comments);

  if (classifications.length === 0) {
    if (pr.ciStatus === 'failure') {
      await approvals.file({
        id: `pr-ci-failure:${pr.repo}#${pr.number}`,
        source: 'pr_monitoring',
        action: 'investigate_ci_failure',
        target: `${pr.repo}#${pr.number}`,
        targetUrl: pr.url,
        context: { pr },
        reasoning: `CI is failing on ${pr.repo}#${pr.number} with no review comments to explain why.`,
        riskLevel: 'medium',
        consequenceIfApproved: 'Nothing automated happens — CI logs need a human look.',
        recommendedAction: `Check the failing CI run on ${pr.url} directly.`,
      });
      await audit.log('pr_monitor_escalated', { reason: 'ci_failure_no_comments' });
      return { outcome: 'escalated', pr, reasons: ['CI failing with no comments to act on'] };
    }
    await audit.log('pr_monitor_no_action', { reason: 'nothing to address' });
    return { outcome: 'no_action_needed', pr, reasons: ['no unresolved comments, CI not failing'] };
  }

  const escalations = classifications.filter((c) => c.verdict === 'escalate');
  const straightforward = classifications.filter((c) => c.verdict === 'straightforward');

  if (escalations.length > 0) {
    await approvals.file({
      id: `pr-feedback:${pr.repo}#${pr.number}`,
      source: 'pr_monitoring',
      action: 'respond_to_review_feedback',
      target: `${pr.repo}#${pr.number}`,
      targetUrl: pr.url,
      context: { pr, escalations: escalations.map((e) => e.comment), straightforward: straightforward.map((s) => s.comment) },
      reasoning: summarizeFeedback(escalations),
      riskLevel: 'medium',
      consequenceIfApproved: 'Nothing automated happens — this surfaces feedback that needs your judgment before any implementation.',
      recommendedAction: buildRecommendedResponse(pr, escalations),
    });
    await audit.log('pr_monitor_escalated', { count: escalations.length });
    return { outcome: 'escalated', pr, reasons: escalations.flatMap((e) => e.reasons) };
  }

  // Every unresolved comment is straightforward — attempt to implement the fix
  // directly on the existing PR branch (no new branch, no new PR).
  const wtManager = deps.worktreeManagerFactory ? deps.worktreeManagerFactory() : new WorktreeManager(deps.repoLocalPath);
  const worktreePath = await wtManager.createForBranch(`pr${pr.number}`, pr.branch);
  await audit.log('pr_monitor_worktree_created', { path: worktreePath, branch: pr.branch });

  const feedbackList = straightforward.map((s) => `- ${s.comment.author}: ${s.comment.body}`).join('\n');
  const prompt = `You are addressing review feedback on an already-open PR, in an isolated git worktree checked
out on the PR's own branch. Follow this order strictly:

1. INSPECT FIRST. Read the current code before changing anything.
2. Implement ONLY what the feedback below asks for. Do not expand scope.
3. Run the project's test suite, lint, typecheck, and build and fix any failures.

Hard constraints: same as before — no git commit/push/branch changes (the orchestrator
handles that), no CI/env/lockfile/migration changes, no Slack/Jira/GitHub writes, no
merging or deploying. If any of this feedback is ambiguous, STOP and say so.

PR: ${pr.repo}#${pr.number}
URL: ${pr.url}

Feedback to address:
${feedbackList}

Report back: what you changed, and the test/lint/typecheck/build results.
`;

  const outcome = await deps.claudeRunner.run(worktreePath, prompt);
  await audit.log('pr_monitor_implementation_finished', { success: outcome.success, summary: outcome.summary });

  if (!outcome.success) {
    await approvals.file({
      id: `pr-feedback:${pr.repo}#${pr.number}`,
      source: 'pr_monitoring',
      action: 'manual_review_implementation_stopped',
      target: `${pr.repo}#${pr.number}`,
      targetUrl: pr.url,
      context: { pr, summary: outcome.summary },
      reasoning: outcome.summary,
      riskLevel: 'medium',
      consequenceIfApproved: 'Nothing automated happens.',
      recommendedAction: `Read the implementer's explanation and address ${pr.repo}#${pr.number}'s feedback manually.`,
    });
    await audit.log('pr_monitor_escalated', { reason: outcome.summary });
    return { outcome: 'escalated', pr, reasons: [outcome.summary], worktreePath };
  }

  const checks = await runChecks(worktreePath, deps.checkCommands ?? DEFAULT_COMMANDS, undefined, deps.checkRetries);
  await audit.log('pr_monitor_checks_run', { results: checks.map((c) => ({ name: c.name, passed: c.passed })) });

  const diffStat = await deps.gitOps.diffStat(worktreePath, 'HEAD');
  const gateDecision = evaluateGate(checks, diffStat, deps.gateConfig);
  await audit.log('pr_monitor_gate_decision', { proceed: gateDecision.proceed, reasons: gateDecision.reasons });

  if (!gateDecision.proceed) {
    await approvals.file({
      id: `pr-feedback:${pr.repo}#${pr.number}`,
      source: 'pr_monitoring',
      action: 'manual_review_failed_gate',
      target: `${pr.repo}#${pr.number}`,
      targetUrl: pr.url,
      context: { pr, checks, diffStat },
      reasoning: gateDecision.reasons.join('; '),
      riskLevel: 'medium',
      consequenceIfApproved: 'Nothing automated happens — the change stays uncommitted in the worktree for manual review.',
      recommendedAction: `Inspect the worktree at ${worktreePath} and either fix it manually or discard it.`,
    });
    await audit.log('pr_monitor_stopped_failed_checks', { reasons: gateDecision.reasons });
    return { outcome: 'stopped_failed_checks', pr, reasons: gateDecision.reasons, worktreePath };
  }

  const committed = await deps.gitOps.commitAll(
    worktreePath,
    `Address review feedback on ${pr.repo}#${pr.number}\n\n${outcome.summary}`,
  );
  if (!committed) {
    await approvals.file({
      id: `pr-feedback:${pr.repo}#${pr.number}`,
      source: 'pr_monitoring',
      action: 'manual_review_empty_diff',
      target: `${pr.repo}#${pr.number}`,
      targetUrl: pr.url,
      context: { pr },
      reasoning: 'implementation reported success but produced no file changes',
      riskLevel: 'medium',
      consequenceIfApproved: 'Nothing automated happens.',
      recommendedAction: `Investigate why addressing feedback on ${pr.repo}#${pr.number} produced no diff.`,
    });
    await audit.log('pr_monitor_escalated', { reason: 'empty diff' });
    return { outcome: 'escalated', pr, reasons: ['implementation produced no changes'], worktreePath };
  }

  await deps.gitOps.push(worktreePath, pr.branch);
  await audit.log('pr_monitor_pushed_followup', { branch: pr.branch });

  return { outcome: 'auto_fix_pushed', pr, reasons: gateDecision.reasons, worktreePath };
}
