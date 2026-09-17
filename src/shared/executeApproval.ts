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

  const context = approval.context as {
    taskKey?: string;
    minutes?: number;
    taskSummary?: string;
    workSummary?: string;
    prUrl?: string;
  };
  const { taskKey, minutes, taskSummary, workSummary, prUrl } = context;
  if (!taskKey || !minutes || minutes <= 0) {
    throw new Error(`log_execution_time approval ${approval.id} has invalid context: ${JSON.stringify(approval.context)}`);
  }

  // taskSummary/workSummary/prUrl are only present on approvals filed by
  // this run of Work Agent — older pending rows filed before this context
  // was added fall back to the ticket's own summary rather than throwing.
  // Written as a plain, factual note — no agent/tool attribution — so it
  // reads like any other worklog entry.
  const comment = [
    workSummary ? `${workSummary}.` : (taskSummary ?? 'Completed.'),
    prUrl ? `PR: ${prUrl}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  // The ad-hoc `log-time --jira` path always passes an explicit `date`
  // (see cli.ts); this path used to omit it entirely, leaving Jira's
  // "started" field unset on the worklog it wrote — the one concrete
  // difference between the two, and the first thing worth ruling out if a
  // worklog appears on the Jira issue but not in a same-day board/mirror
  // sync elsewhere. Pin both writes to the same explicit date so the two
  // paths are identical in every way that could matter.
  const date = new Date().toISOString().slice(0, 10);
  const writer = deps.getWorklogWriter();
  await writer.logWork(taskKey, minutes, { comment, date });
  await logTime(db, {
    date,
    minutes,
    jiraKey: taskKey,
    note: 'Execution time (Jira worklog)',
  });
}
