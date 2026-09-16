import { describe, expect, it } from 'vitest';
import { correlate } from '../src/pipeline/correlate.js';
import type { GitHubPr, JiraIssue, SlackMessage } from '../src/models/types.js';

function makeIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: 'ABC-1',
    project: 'ABC',
    summary: 'summary',
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
    title: 'ABC-1: fix the bug',
    url: 'http://pr',
    state: 'open',
    isDraft: false,
    branch: 'feature/x',
    isAuthor: true,
    reviewRequestedOfMe: false,
    reviewState: 'none',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeMsg(overrides: Partial<SlackMessage> = {}): SlackMessage {
  return {
    channel: 'C1',
    channelName: '#c',
    ts: '1.0',
    user: 'U1',
    text: 'any update?',
    permalink: 'http://slack',
    mentionsMe: false,
    ...overrides,
  };
}

describe('correlate', () => {
  it('links a PR to its matching Jira issue', () => {
    const items = correlate([makeIssue()], [makePr()], []);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('ABC-1');
    expect(items[0]!.prs).toHaveLength(1);
  });

  it('makes an unmatched PR standalone', () => {
    const pr = makePr({ title: 'chore: bump deps', branch: 'chore/bump' });
    const items = correlate([], [pr], []);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('pr:org/repo#1');
    expect(items[0]!.jira).toBeNull();
  });

  it('links a Slack message with a matching key', () => {
    const msg = makeMsg({ text: 'any update on ABC-1?' });
    const items = correlate([makeIssue()], [], [msg]);
    expect(items[0]!.slackMessages).toHaveLength(1);
  });

  it('makes a mention-without-key Slack message standalone', () => {
    const msg = makeMsg({ text: '@you take a look?', mentionsMe: true });
    const items = correlate([], [], [msg]);
    expect(items).toHaveLength(1);
    expect(items[0]!.id.startsWith('slack:')).toBe(true);
  });

  it('drops a Slack message with no key and no mention', () => {
    const msg = makeMsg({ text: 'lunch at 1?', mentionsMe: false });
    expect(correlate([], [], [msg])).toEqual([]);
  });

  it('keeps a Jira issue with no PRs or messages', () => {
    const items = correlate([makeIssue({ key: 'ABC-2' })], [], []);
    expect(items[0]!.prs).toEqual([]);
    expect(items[0]!.slackMessages).toEqual([]);
  });

  it('links a PR via a Jira-side linkedPrRefs match even when the PR title/branch mentions no key', () => {
    const issue = makeIssue({ key: 'ABC-1', linkedPrRefs: [{ repo: 'org/repo', number: 58 }] });
    const pr = makePr({ number: 58, title: 'fix(reports): unrelated title', branch: 'fix/unrelated' });
    const items = correlate([issue], [pr], []);
    expect(items).toHaveLength(1);
    expect(items[0]!.prs).toHaveLength(1);
    expect(items[0]!.prs[0]!.number).toBe(58);
  });

  it('does not duplicate a PR already matched by title/branch even if also linkedPrRefs-matched', () => {
    const issue = makeIssue({ key: 'ABC-1', linkedPrRefs: [{ repo: 'org/repo', number: 1 }] });
    const items = correlate([issue], [makePr()], []);
    expect(items[0]!.prs).toHaveLength(1);
  });

  it('removes a linkedPrRefs-matched PR from standalone once attached to its issue', () => {
    const issue = makeIssue({ key: 'ABC-1', linkedPrRefs: [{ repo: 'org/repo', number: 58 }] });
    const pr = makePr({ number: 58, title: 'no key here', branch: 'no-key-branch' });
    const items = correlate([issue], [pr], []);
    expect(items.some((i) => i.id === 'pr:org/repo#58')).toBe(false);
  });

  it('ignores a linkedPrRefs entry with no matching fetched PR', () => {
    const issue = makeIssue({ key: 'ABC-1', linkedPrRefs: [{ repo: 'org/repo', number: 999 }] });
    const items = correlate([issue], [], []);
    expect(items[0]!.prs).toEqual([]);
  });

  it('links one PR to multiple matching issues', () => {
    const issue1 = makeIssue({ key: 'ABC-1' });
    const issue2 = makeIssue({ key: 'ABC-2' });
    const pr = makePr({ title: 'ABC-1 and ABC-2: shared fix' });
    const items = correlate([issue1, issue2], [pr], []);
    const ids = new Set(items.map((i) => i.id));
    expect(ids).toEqual(new Set(['ABC-1', 'ABC-2']));
  });
});
