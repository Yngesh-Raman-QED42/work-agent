import type { AnyDb } from '../db/index.js';
import type { ApprovalRow } from './approvals.js';
import { logTime } from '../agents/workLog/timeEntry.js';
import type { JiraWorklogWriter } from '../integrations/jira/worklogWriter.js';

export interface ExecuteApprovalDeps {
  // A factory, not an instance — so a live writer (which throws in its
  // constructor without real Jira credentials) is only ever constructed
  // for the one action that actually needs it, never for every approval.
  getWorklogWriter: () => JiraWorklogWriter;
}

/**
 * Approving almost everything in the queue changes nothing by itself — it's
 * just a record that you've seen and accepted something that already
 * happened elsewhere. `log_execution_time` is the deliberate exception:
 * approving it is what actually writes the Jira worklog. This is an
 * explicit allowlist of one action, not a generic "run whatever the
 * approval says to run" mechanism — every other action is still purely
 * informational on approval.
 */
export async function executeApprovedAction(db: AnyDb, approval: ApprovalRow, deps: ExecuteApprovalDeps): Promise<void> {
  if (approval.action !== 'log_execution_time') return;

  const context = approval.context as { taskKey?: string; minutes?: number };
  const { taskKey, minutes } = context;
  if (!taskKey || !minutes || minutes <= 0) {
    throw new Error(`log_execution_time approval ${approval.id} has invalid context: ${JSON.stringify(approval.context)}`);
  }

  const writer = deps.getWorklogWriter();
  await writer.logWork(taskKey, minutes, { comment: 'Logged by Work Agent — autonomous implementation time' });
  await logTime(db, {
    date: new Date().toISOString().slice(0, 10),
    minutes,
    jiraKey: taskKey,
    note: 'Autonomous execution time (Jira worklog)',
  });
}
