import type { AnyDb } from '../db/index.js';
import type { WorkAgentConfig } from '../config/index.js';
import type { GitHubConnector, JiraConnector, SlackConnector } from '../integrations/types.js';
import type { JiraDetailReader } from '../integrations/jira/detail.js';
import { runPipeline, type PipelineResult } from '../pipeline/run.js';
import { runSlackIntelligence } from '../agents/slackIntelligence/runbook.js';
import type { SlackIntelligenceResult } from '../agents/slackIntelligence/runbook.js';
import { assessAssignment, type TaskIntelligenceResult } from '../agents/taskIntelligence/runbook.js';
import { AutonomyPolicy } from '../agents/engineeringExecution/policy.js';
import { runExecution } from '../agents/engineeringExecution/runbook.js';
import type { ExecutionResult } from '../agents/engineeringExecution/models.js';
import type { ClaudeCodeRunner } from '../agents/engineeringExecution/claudeRunner.js';
import type { GitOps } from '../agents/engineeringExecution/gitOps.js';
import type { PullRequestCreator } from '../agents/engineeringExecution/prOps.js';
import type { WorktreeManager } from '../agents/engineeringExecution/worktree.js';
import { monitorPr } from '../agents/prMonitoring/runbook.js';
import type { MonitorResult } from '../agents/prMonitoring/models.js';
import type { PrStatusReader } from '../agents/prMonitoring/githubReader.js';
import { AuditLog } from '../pipeline/audit.js';

export interface OrchestratorDeps {
  db: AnyDb;
  config: WorkAgentConfig;
  connectors: { slack: SlackConnector; jira: JiraConnector; github: GitHubConnector };
  jiraDetailReader: JiraDetailReader;
  gitOps: GitOps;
  prCreator: PullRequestCreator;
  prStatusReader: PrStatusReader;
  /** Omit this to run a read-only cycle (observation + Slack/Task
   * Intelligence only). Engineering Execution and PR-followup
   * implementation both need a properly-permissioned coding agent, which
   * only a live Claude Code session can provide (see claudeRunner.ts) — so
   * those two steps are simply skipped, not faked, when this is absent. */
  claudeRunner?: ClaudeCodeRunner;
  /** Test seam only — production code lets each agent construct its own
   * real WorktreeManager. */
  worktreeManagerFactory?: (localPath: string) => WorktreeManager;
}

export interface OrchestratorResult {
  observation: PipelineResult;
  slackIntelligence: SlackIntelligenceResult;
  taskIntelligenceResults: TaskIntelligenceResult[];
  executionResults: ExecutionResult[];
  prMonitorResults: MonitorResult[];
}

/**
 * The Work Orchestrator: decides what should happen next and coordinates
 * the specialized agents, in this order —
 *   1. Observation (Slack/Jira/GitHub collect -> correlate -> classify -> briefing)
 *   2. Slack Intelligence (classify collected Slack messages)
 *   3. Task Intelligence (for each task_assignment signal with a linked
 *      Jira key: fetch full ticket detail, decide clear-enough-to-start)
 *   4. Engineering Execution (only for tickets Task Intelligence marked
 *      ready, and only if a live coding agent is available)
 *   5. PR Monitoring (for every open PR you authored that observation
 *      found, and only if a live coding agent is available)
 *
 * Each step's own agent decides autonomy vs. approval-queue internally —
 * this function's only job is sequencing and handing outputs to the next
 * step, not making risk decisions itself.
 */
export async function runOrchestratorCycle(deps: OrchestratorDeps): Promise<OrchestratorResult> {
  const audit = new AuditLog(deps.db);
  await audit.log('orchestrator_cycle_started', {});

  const observation = await runPipeline(deps.db, deps.connectors);

  const messages = await deps.connectors.slack.fetchRelevantMessages({ lookbackHours: 24 });
  const slackIntelligence = await runSlackIntelligence(deps.db, messages);

  const policy = new AutonomyPolicy({
    allowedProjects: deps.config.jira.myProjects.length > 0 ? new Set(deps.config.jira.myProjects) : undefined,
  });

  const assignments = slackIntelligence.classifications.filter((c) => c.category === 'task_assignment' && c.linkedJiraKey);
  const taskIntelligenceResults: TaskIntelligenceResult[] = [];
  for (const a of assignments) {
    const result = await assessAssignment(
      { db: deps.db, policy, detailReader: deps.jiraDetailReader },
      a.linkedJiraKey!,
      { channel: a.message.channel, ts: a.message.ts, text: a.message.text },
    );
    taskIntelligenceResults.push(result);
  }
  await audit.log('orchestrator_task_intelligence_done', { count: taskIntelligenceResults.length });

  const executionResults: ExecutionResult[] = [];
  if (deps.claudeRunner) {
    const readyTasks = taskIntelligenceResults.filter((r) => r.outcome === 'ready_for_execution').map((r) => r.task!);
    if (readyTasks.length > 0) {
      const result = await runExecution({
        db: deps.db,
        config: deps.config,
        candidates: readyTasks,
        policy,
        claudeRunner: deps.claudeRunner,
        gitOps: deps.gitOps,
        prCreator: deps.prCreator,
        worktreeManagerFactory: deps.worktreeManagerFactory,
      });
      executionResults.push(result);
    }
  }

  const prMonitorResults: MonitorResult[] = [];
  if (deps.claudeRunner) {
    const myOpenPrs = new Map<string, string>(); // "repo#number" -> repo
    for (const item of observation.items) {
      for (const pr of item.prs) {
        if (pr.isAuthor && pr.state === 'open') myOpenPrs.set(`${pr.repo}#${pr.number}`, pr.repo);
      }
    }
    for (const [key, repo] of myOpenPrs) {
      const numStr = key.slice(repo.length + 1);
      const localPath = deps.config.github.repoLocalPaths[repo];
      if (!localPath) {
        await audit.log('orchestrator_pr_monitor_skipped', { repo, reason: 'no repoLocalPaths entry configured' });
        continue;
      }
      const result = await monitorPr({
        db: deps.db,
        repo,
        number: Number(numStr),
        reader: deps.prStatusReader,
        claudeRunner: deps.claudeRunner,
        gitOps: deps.gitOps,
        repoLocalPath: localPath,
      });
      prMonitorResults.push(result);
    }
  }

  await audit.log('orchestrator_cycle_completed', {
    execution_count: executionResults.length,
    pr_monitor_count: prMonitorResults.length,
  });

  return { observation, slackIntelligence, taskIntelligenceResults, executionResults, prMonitorResults };
}
