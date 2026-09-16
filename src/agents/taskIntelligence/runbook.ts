import type { AnyDb } from '../../db/index.js';
import { AuditLog } from '../../pipeline/audit.js';
import { ApprovalsStore } from '../../shared/approvals.js';
import type { JiraDetailReader, TaskContext } from '../../integrations/jira/detail.js';
import type { AutonomyPolicy } from '../engineeringExecution/policy.js';

export interface TaskIntelligenceDeps {
  db: AnyDb;
  policy: AutonomyPolicy;
  detailReader: JiraDetailReader;
}

export interface SourceSignal {
  channel: string;
  ts: string;
  text: string;
}

export type TaskIntelligenceOutcome = 'ready_for_execution' | 'ambiguous' | 'no_ticket_found';

export interface TaskIntelligenceResult {
  outcome: TaskIntelligenceOutcome;
  task?: TaskContext;
  reasons: string[];
}

/**
 * Given a Jira key a Slack Intelligence signal identified as a task
 * assignment, decides whether there's enough to safely start autonomous
 * work — reusing the SAME AutonomyPolicy the Engineering Execution agent
 * uses, since "is this assignment clear enough" and "does this qualify for
 * autonomy" are the same question asked from two different entry points.
 */
export async function assessAssignment(
  deps: TaskIntelligenceDeps,
  jiraKey: string,
  sourceSignal: SourceSignal,
): Promise<TaskIntelligenceResult> {
  const audit = new AuditLog(deps.db);
  const approvals = new ApprovalsStore(deps.db);
  await audit.log('task_intelligence_started', { jira_key: jiraKey });

  let task: TaskContext;
  try {
    task = await deps.detailReader.fetchIssueDetail(jiraKey);
  } catch (err) {
    const reason = `could not fetch ${jiraKey} from Jira: ${String(err)}`;
    await approvals.file({
      id: `task-intel-not-found:${jiraKey}`,
      source: 'task_intelligence',
      action: 'manual_review_ticket_not_found',
      target: jiraKey,
      targetUrl: null,
      context: { jiraKey, slackSignal: sourceSignal, error: String(err) },
      reasoning: reason,
      riskLevel: 'low',
      consequenceIfApproved: 'Nothing automated happens.',
      recommendedAction: `Check that ${jiraKey} exists and is accessible, or correct the ticket link in Slack.`,
    });
    await audit.log('task_intelligence_no_ticket_found', { jira_key: jiraKey });
    return { outcome: 'no_ticket_found', reasons: [reason] };
  }

  const { eligible, reasons } = deps.policy.isEligible(task);
  await audit.log('task_intelligence_assessed', { jira_key: jiraKey, eligible, reasons });

  if (!eligible) {
    await approvals.file({
      id: `task-intel-ambiguous:${jiraKey}`,
      source: 'task_intelligence',
      action: 'clarify_task_assignment',
      target: jiraKey,
      targetUrl: task.url,
      context: { task, slackSignal: sourceSignal },
      reasoning: reasons.join('; '),
      riskLevel: 'low',
      consequenceIfApproved: 'Nothing automated happens until you clarify, reassign, or adjust the ticket.',
      recommendedAction: `${jiraKey} doesn't currently qualify for autonomous execution (${reasons[0]}). Handle it yourself, or update the ticket so it qualifies.`,
    });
    await audit.log('task_intelligence_ambiguous', { jira_key: jiraKey, reasons });
    return { outcome: 'ambiguous', task, reasons };
  }

  await audit.log('task_intelligence_ready', { jira_key: jiraKey });
  return { outcome: 'ready_for_execution', task, reasons };
}
