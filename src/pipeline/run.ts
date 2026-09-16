import type { AnyDb } from '../db/index.js';
import type { GitHubConnector, JiraConnector, SlackConnector } from '../integrations/types.js';
import { classifyAll } from './classify.js';
import { correlate } from './correlate.js';
import { AuditLog } from './audit.js';
import { diffState, loadPrevious, saveCurrent, type StateDiff } from './state.js';
import { generateBriefing, persistBriefing } from './briefing.js';
import { generateApprovalEntries } from './approvalQueue.js';
import { ApprovalsStore, type ApprovalInput } from '../shared/approvals.js';
import type { WorkItem } from '../models/types.js';

export interface PipelineResult {
  items: WorkItem[];
  diff: StateDiff;
  briefing: string;
  approvalQueue: ApprovalInput[];
}

export interface PipelineConfig {
  lookbackHours?: number;
  runDate?: string;
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

  const issues = await connectors.jira.fetchMyOpenIssues();
  await audit.log('collected_jira', { count: issues.length });

  const prs = await connectors.github.fetchMyPullRequests();
  await audit.log('collected_github', { count: prs.length });

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
  await new ApprovalsStore(db).fileMany(queue);
  await audit.log('approval_queue_generated', { count: queue.length });

  await audit.log('run_completed', {});

  return { items, diff, briefing, approvalQueue: queue };
}
