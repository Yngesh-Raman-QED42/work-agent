import { eq, inArray } from 'drizzle-orm';
import type { AnyDb } from '../db/index.js';
import type { GitHubConnector, JiraConnector, SlackConnector } from '../integrations/types.js';
import { classifyAll } from './classify.js';
import { correlate } from './correlate.js';
import { AuditLog } from './audit.js';
import { diffState, loadPrevious, saveCurrent, type StateDiff } from './state.js';
import { generateBriefing, persistBriefing } from './briefing.js';
import { generateApprovalEntries } from './approvalQueue.js';
import { ApprovalsStore, type ApprovalInput } from '../shared/approvals.js';
import { executionTasks } from '../db/schema.js';
import type { GitHubPr, WorkItem } from '../models/types.js';

/**
 * Engineering Execution's own DB row for a ticket ("monitoring": a PR is
 * open, still being watched) is never touched again by anything else —
 * unlike work_items, it isn't fully replaced each run. If that PR gets
 * closed outside this system (a human closes it, or it's been discarded
 * and redone, as happened repeatedly during testing), the row just sits
 * there forever claiming a PR is still in review that no longer exists.
 * `fetchMyPullRequests` only ever returns OPEN PRs, so "not in this list"
 * reliably means "no longer open" — safe to drop.
 */
async function reconcileExecutionTasks(db: AnyDb, prs: GitHubPr[]): Promise<number> {
  const openUrls = new Set(prs.map((p) => p.url));
  const monitoring = await db
    .select({ id: executionTasks.id, prUrl: executionTasks.prUrl })
    .from(executionTasks)
    .where(eq(executionTasks.status, 'monitoring'));
  const staleIds = monitoring.filter((t) => t.prUrl && !openUrls.has(t.prUrl)).map((t) => t.id);
  if (staleIds.length > 0) await db.delete(executionTasks).where(inArray(executionTasks.id, staleIds));
  return staleIds.length;
}

export interface PipelineResult {
  items: WorkItem[];
  diff: StateDiff;
  briefing: string;
  approvalQueue: ApprovalInput[];
}

export interface PipelineConfig {
  lookbackHours?: number;
  runDate?: string;
  // Ticket keys to exclude before anything else ever sees them — see
  // jira.ignoredKeys in work-agent.config.json. Empty by default: nothing
  // assigned to you is hidden unless you explicitly say so.
  ignoredKeys?: string[];
}

export async function runPipeline(
  db: AnyDb,
  connectors: { slack: SlackConnector; jira: JiraConnector; github: GitHubConnector },
  config: PipelineConfig = {},
): Promise<PipelineResult> {
  const runDate = config.runDate ?? new Date().toISOString().slice(0, 10);
  const lookbackHours = config.lookbackHours ?? 24;
  const audit = new AuditLog(db);

  await audit.log('run_started', { run_date: runDate });

  const messages = await connectors.slack.fetchRelevantMessages({ lookbackHours });
  await audit.log('collected_slack', { count: messages.length });

  const ignoredKeys = new Set(config.ignoredKeys ?? []);
  const fetchedIssues = await connectors.jira.fetchMyOpenIssues();
  const issues = fetchedIssues.filter((issue) => !ignoredKeys.has(issue.key));
  await audit.log('collected_jira', { count: issues.length, ignored: fetchedIssues.length - issues.length });

  const prs = await connectors.github.fetchMyPullRequests();
  await audit.log('collected_github', { count: prs.length });

  const staleExecutionTasks = await reconcileExecutionTasks(db, prs);
  if (staleExecutionTasks > 0) await audit.log('execution_tasks_reconciled', { removed: staleExecutionTasks });

  let items = correlate(issues, prs, messages);
  await audit.log('correlated', { work_item_count: items.length });

  items = classifyAll(items);
  const byCategory: Record<string, number> = {};
  for (const item of items) byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
  await audit.log('classified', { by_category: byCategory });

  const previous = await loadPrevious(db);
  const diff = diffState(previous, items);
  await saveCurrent(db, items);
  await audit.log('state_updated', diff);

  const briefing = generateBriefing(items, diff, runDate);
  await persistBriefing(db, runDate, briefing);
  await audit.log('briefing_generated', { run_date: runDate });

  const queue = generateApprovalEntries(items);
  const approvalsStore = new ApprovalsStore(db);
  await approvalsStore.fileMany(queue);
  // Drop any previously-filed observation approval whose condition no
  // longer holds (e.g. a PR has since been opened) — see reconcile()'s doc.
  await approvalsStore.reconcile('observation', queue.map((q) => q.id));
  await audit.log('approval_queue_generated', { count: queue.length });

  await audit.log('run_completed', {});

  return { items, diff, briefing, approvalQueue: queue };
}
