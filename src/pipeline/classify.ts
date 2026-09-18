import type { Category, Urgency, WorkItem } from '../models/types.js';

const URGENCY_RANK: Record<Urgency, number> = { high: 0, medium: 1, low: 2 };
const HIGH_PRIORITY_NAMES = new Set(['highest', 'high']);

/** Deterministic, rule-based classification — no ML/LLM call in Phase 1. */
export function classify(item: WorkItem): WorkItem {
  let category: Category = 'fyi';
  let urgency: Urgency = 'low';
  const reasons: string[] = [];

  for (const pr of item.prs) {
    if (pr.reviewRequestedOfMe && pr.state === 'open') {
      category = 'needs_review';
      urgency = 'high';
      reasons.push(`Review requested on ${pr.repo}#${pr.number}`);
    } else if (pr.isAuthor && pr.reviewState === 'changes_requested') {
      category = 'needs_action';
      urgency = 'high';
      reasons.push(`Changes requested on your PR ${pr.repo}#${pr.number}`);
    } else if (pr.isAuthor && pr.state === 'open' && category === 'fyi') {
      category = 'waiting_on_others';
      urgency = 'medium';
      reasons.push(`Your PR ${pr.repo}#${pr.number} is awaiting review`);
    }
  }

  if (item.jira) {
    const issue = item.jira;
    if (issue.status.toLowerCase() === 'on hold') {
      if (category === 'fyi') {
        category = 'blocked';
        urgency = 'medium';
      }
      reasons.push(`${issue.key} is On Hold`);
    } else if (issue.statusCategory === 'In Progress' && item.prs.length === 0) {
      if (category === 'fyi') {
        category = 'needs_action';
        urgency = 'medium';
      }
      reasons.push(`${issue.key} is in progress with no linked PR yet`);
    } else if (issue.statusCategory === 'To Do' && item.prs.length === 0) {
      // A ticket assigned to you that you haven't started is real, visible
      // open work — not "informational." Landing it in the same low-signal
      // "fyi" bucket as an unrelated PR someone mentioned once hid it behind
      // a collapsed section by default, indistinguishable from actual noise.
      if (category === 'fyi') {
        category = 'needs_action';
      }
      reasons.push(`${issue.key} is assigned to you and hasn't been started yet`);
    }

    if (HIGH_PRIORITY_NAMES.has(issue.priority.toLowerCase()) && URGENCY_RANK[urgency] > URGENCY_RANK.high) {
      urgency = 'high';
      reasons.push(`${issue.key} priority is ${issue.priority}`);
    }
  }

  // A merged PR means the ticket is effectively done from your side — a
  // Slack message asking about progress from before it merged is stale
  // context now, not a live reason to surface this as needing attention.
  // ("Recently merged" already gives the merge itself its own visibility.)
  const hasMergedPr = item.prs.some((pr) => pr.state === 'merged');
  if (item.slackMessages.length > 0 && category === 'fyi' && !hasMergedPr) {
    category = 'slack_mention';
    reasons.push(`${item.slackMessages.length} Slack message(s) reference this`);
  }

  item.category = category;
  item.urgency = urgency;
  item.reasons = reasons;
  return item;
}

export function classifyAll(items: WorkItem[]): WorkItem[] {
  return items.map(classify);
}
