import { describe, expect, it } from 'vitest';
import { generateApprovalEntries } from '../src/pipeline/approvalQueue.js';
import type { GitHubPr, JiraIssue, WorkItem } from '../src/models/types.js';

function makePr(overrides: Partial<GitHubPr> = {}): GitHubPr {
  return {
    repo: 'org/repo',
    number: 1,
    title: 'ABC-1: fix',
    url: 'http://pr',
    state: 'open',
    isDraft: false,
    branch: 'fix/abc-1',
    isAuthor: true,
    reviewRequestedOfMe: false,
    reviewState: 'none',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeIssue(status = 'On Hold'): JiraIssue {
  return {
    key: 'ABC-1',
    project: 'ABC',
    summary: 's',
    status,
    statusCategory: 'In Progress',
    priority: 'Medium',
    updated: '2026-01-01T00:00:00Z',
    url: 'http://x',
  };
}

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return { id: 'ABC-1', jira: null, prs: [], slackMessages: [], category: 'fyi', urgency: 'low', reasons: [], ...overrides };
}

describe('generateApprovalEntries', () => {
  it('needs_review produces a review action', () => {
    const item = makeItem({ prs: [makePr({ isAuthor: false, reviewRequestedOfMe: true })], category: 'needs_review' });
    const queue = generateApprovalEntries([item]);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.action).toBe('review_pull_request');
    expect(queue[0]!.source).toBe('observation');
    expect(queue[0]!.riskLevel).toBe('low');
  });

  it('changes requested produces address_review_comments', () => {
    const item = makeItem({ prs: [makePr({ isAuthor: true, reviewState: 'changes_requested' })], category: 'needs_action' });
    const queue = generateApprovalEntries([item]);
    expect(queue[0]!.action).toBe('address_review_comments');
  });

  it('in-progress with no PR produces create_branch_or_pr', () => {
    const item = makeItem({ jira: makeIssue('In Progress'), category: 'needs_action' });
    const queue = generateApprovalEntries([item]);
    expect(queue[0]!.action).toBe('create_branch_or_pr');
  });

  it('blocked produces a followup action', () => {
    const item = makeItem({ jira: makeIssue('On Hold'), category: 'blocked' });
    const queue = generateApprovalEntries([item]);
    expect(queue[0]!.action).toBe('comment_asking_for_unblock_status');
  });

  it('fyi produces no action', () => {
    const item = makeItem({ jira: makeIssue('To Do'), category: 'fyi' });
    expect(generateApprovalEntries([item])).toEqual([]);
  });

  it('every entry carries the fields the Human Approval system requires', () => {
    const items = [
      makeItem({ id: 'A', prs: [makePr({ isAuthor: false, reviewRequestedOfMe: true })], category: 'needs_review' }),
      makeItem({ id: 'B', jira: makeIssue('On Hold'), category: 'blocked' }),
    ];
    const queue = generateApprovalEntries(items);
    for (const entry of queue) {
      expect(entry.reasoning.length).toBeGreaterThan(0);
      expect(entry.consequenceIfApproved.length).toBeGreaterThan(0);
      expect(entry.recommendedAction.length).toBeGreaterThan(0);
      expect(['low', 'medium', 'high']).toContain(entry.riskLevel);
    }
  });
});
