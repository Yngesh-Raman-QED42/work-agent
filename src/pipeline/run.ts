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
 * unlike work_items, it isn't fully replaced each run. `fetchMyPullRequests`
 * now returns recently-merged PRs too (not just open ones — see
 * LiveGitHubConnector), so a monitoring row whose PR has merged gets marked
 * "done" instead of silently claiming to still be in review forever. A row
 * whose PR isn't in the fetch at all (closed without merging, deleted, or
 * simply fell out of the merged-PR lookback window) gets dropped — there's
 * nothing left to say about it.
 */
async function reconcileExecutionTasks(db: AnyDb, prs: GitHubPr[]): Promise<{ removed: number; markedDone: number }> {
  const byUrl = new Map(prs.map((p) => [p.url, p]));
  const monitoring = await db
    .select({ id: executionTasks.id, prUrl: executionTasks.prUrl })
    .from(executionTasks)
    .where(eq(executionTasks.status, 'monitoring'));

  const toRemove: string[] = [];
  const toMarkDone: string[] = [];
  for (const t of monitoring) {
    if (!t.prUrl) continue;
    const match = byUrl.get(t.prUrl);
    if (!match) toRemove.push(t.id);
    else if (match.state === 'merged') toMarkDone.push(t.id);
  }

  if (toRemove.length > 0) await db.delete(executionTasks).where(inArray(executionTasks.id, toRemove));
  if (toMarkDone.length > 0) {
    await db.update(executionTasks).set({ status: 'done', updatedAt: new Date() }).where(inArray(executionTasks.id, toMarkDone));
  }
  return { removed: toRemove.length, markedDone: toMarkDone.length };
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

  const execReconcile = await reconcileExecutionTasks(db, prs);
  if (execReconcile.removed > 0 || execReconcile.markedDone > 0) await audit.log('execution_tasks_reconciled', execReconcile);

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
