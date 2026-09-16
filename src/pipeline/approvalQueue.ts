import type { ApprovalInput } from '../shared/approvals.js';
import type { WorkItem } from '../models/types.js';

// Phase 1 only ever *proposes* actions for a human to approve later —
// nothing in this module executes anything against Slack/Jira/GitHub.
export function generateApprovalEntries(items: WorkItem[]): ApprovalInput[] {
  const queue: ApprovalInput[] = [];

  for (const item of items) {
    if (item.category === 'needs_review') {
      for (const pr of item.prs) {
        if (pr.reviewRequestedOfMe && pr.state === 'open') {
          queue.push({
            id: `review:${pr.repo}#${pr.number}`,
            source: 'observation',
            action: 'review_pull_request',
            target: `${pr.repo}#${pr.number}`,
            targetUrl: pr.url,
            context: { pr },
            reasoning: `A review was explicitly requested of you on ${pr.repo}#${pr.number}, and it's still open.`,
            riskLevel: 'low',
            consequenceIfApproved: 'Nothing automated happens — this just surfaces that your review is waiting.',
            recommendedAction: `Review ${pr.repo}#${pr.number}.`,
          });
        }
      }
    }

    if (item.category === 'needs_action') {
      for (const pr of item.prs) {
        if (pr.isAuthor && pr.reviewState === 'changes_requested') {
          queue.push({
            id: `address-review:${pr.repo}#${pr.number}`,
            source: 'observation',
            action: 'address_review_comments',
            target: `${pr.repo}#${pr.number}`,
            targetUrl: pr.url,
            context: { pr },
            reasoning: `A reviewer requested changes on your PR ${pr.repo}#${pr.number}.`,
            riskLevel: 'low',
            consequenceIfApproved: 'Nothing automated happens — this just surfaces that changes are requested.',
            recommendedAction: `Look at the review comments on ${pr.repo}#${pr.number} and address them.`,
          });
        }
      }
      if (item.jira && item.prs.length === 0) {
        queue.push({
          id: `start-pr:${item.jira.key}`,
          source: 'observation',
          action: 'create_branch_or_pr',
          target: item.jira.key,
          targetUrl: item.jira.url,
          context: { jira: item.jira },
          reasoning: `${item.jira.key} is in progress but has no linked PR yet.`,
          riskLevel: 'low',
          consequenceIfApproved: 'Nothing automated happens — this just flags a ticket with no visible progress.',
          recommendedAction: `Start work on ${item.jira.key}, or hand it to the Engineering Execution agent if it qualifies for autonomous work.`,
        });
      }
    }

    if (item.category === 'blocked' && item.jira) {
      queue.push({
        id: `followup:${item.jira.key}`,
        source: 'observation',
        action: 'comment_asking_for_unblock_status',
        target: item.jira.key,
        targetUrl: item.jira.url,
        context: { jira: item.jira },
        reasoning: `${item.jira.key} has been On Hold.`,
        riskLevel: 'low',
        consequenceIfApproved: 'Nothing automated happens — this just flags a stale on-hold ticket.',
        recommendedAction: `Confirm with the ticket owner whether ${item.jira.key} is still blocked or can resume.`,
      });
    }
  }

  return queue;
}
