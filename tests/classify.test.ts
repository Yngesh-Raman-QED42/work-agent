import { describe, expect, it } from 'vitest';
import { classify } from '../src/pipeline/classify.js';
import type { GitHubPr, JiraIssue, SlackMessage, WorkItem } from '../src/models/types.js';

function makeIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: 'ABC-1',
    project: 'ABC',
    summary: 'do the thing',
    status: 'In Progress',
    statusCategory: 'In Progress',
    priority: 'Medium',
    updated: '2026-01-01T00:00:00Z',
    url: 'http://x/ABC-1',
    ...overrides,
  };
}

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

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return { id: 'ABC-1', jira: null, prs: [], slackMessages: [], category: 'fyi', urgency: 'low', reasons: [], ...overrides };
}

describe('classify', () => {
  it('review requested -> needs_review / high', () => {
    const item = makeItem({ prs: [makePr({ isAuthor: false, reviewRequestedOfMe: true })] });
    classify(item);
    expect(item.category).toBe('needs_review');
    expect(item.urgency).toBe('high');
  });

  it('changes requested on own PR -> needs_action / high', () => {
    const item = makeItem({ prs: [makePr({ isAuthor: true, reviewState: 'changes_requested' })] });
    classify(item);
    expect(item.category).toBe('needs_action');
    expect(item.urgency).toBe('high');
  });

  it('own open PR awaiting review -> waiting_on_others / medium', () => {
    const item = makeItem({ prs: [makePr({ isAuthor: true, reviewState: 'none' })] });
    classify(item);
    expect(item.category).toBe('waiting_on_others');
    expect(item.urgency).toBe('medium');
  });

  it('on hold issue -> blocked', () => {
    const item = makeItem({ jira: makeIssue({ status: 'On Hold' }) });
    classify(item);
    expect(item.category).toBe('blocked');
  });

  it('in-progress issue with no PR -> needs_action', () => {
    const item = makeItem({ jira: makeIssue({ status: 'In Progress', statusCategory: 'In Progress' }) });
    classify(item);
    expect(item.category).toBe('needs_action');
  });

  it('to-do issue with no PR -> needs_action, not fyi — assigned, unstarted work is not "informational"', () => {
    const item = makeItem({ jira: makeIssue({ status: 'To Do', statusCategory: 'To Do', priority: 'Medium' }) });
    classify(item);
    expect(item.category).toBe('needs_action');
    expect(item.reasons.some((r) => r.includes("hasn't been started"))).toBe(true);
  });

  it('high priority bumps urgency', () => {
    const item = makeItem({ jira: makeIssue({ status: 'To Do', statusCategory: 'To Do', priority: 'High' }) });
    classify(item);
    expect(item.urgency).toBe('high');
  });

  it('slack-only mention -> slack_mention', () => {
    const msg: SlackMessage = {
      channel: 'C1',
      channelName: '#c',
      ts: '1',
      user: 'U1',
      text: 'hi',
      permalink: 'x',
      mentionsMe: true,
    };
    const item = makeItem({ slackMessages: [msg] });
    classify(item);
    expect(item.category).toBe('slack_mention');
  });

  it('default is fyi / low when nothing matches at all (no jira issue, no PR, no Slack signal)', () => {
    const item = makeItem({ jira: null, prs: [] });
    classify(item);
    expect(item.category).toBe('fyi');
    expect(item.urgency).toBe('low');
  });

  it('reasons populated', () => {
    const item = makeItem({ jira: makeIssue({ status: 'On Hold' }) });
    classify(item);
    expect(item.reasons.some((r) => r.includes('On Hold'))).toBe(true);
  });
});
