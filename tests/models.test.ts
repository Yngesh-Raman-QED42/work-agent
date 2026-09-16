import { describe, expect, it } from 'vitest';
import { extractJiraKeys, slackMessageJiraKeys, prJiraKeys, extractGitHubPrRefs } from '../src/models/types.js';

describe('extractJiraKeys', () => {
  it('finds a single key', () => {
    expect(extractJiraKeys('please check QED42OPSIN-59 today')).toEqual(['QED42OPSIN-59']);
  });

  it('finds multiple unique keys in order', () => {
    expect(extractJiraKeys('relates to ABC-1 and also ABC-1 and DEF-22')).toEqual(['ABC-1', 'DEF-22']);
  });

  it('returns empty when no key present', () => {
    expect(extractJiraKeys('no ticket mentioned here')).toEqual([]);
  });

  it('ignores lowercase project-like text', () => {
    expect(extractJiraKeys('see section-42 of the doc')).toEqual([]);
  });

  it('merges keys across multiple texts', () => {
    expect(extractJiraKeys('see ABC-1', 'and XYZ-2')).toEqual(['ABC-1', 'XYZ-2']);
  });
});

describe('slackMessageJiraKeys', () => {
  it('extracts from message text', () => {
    const msg = {
      channel: 'C1',
      channelName: '#c',
      ts: '1',
      user: 'U1',
      text: 'ping about QED42OPSIN-59',
      permalink: 'http://x',
      mentionsMe: false,
    };
    expect(slackMessageJiraKeys(msg)).toEqual(['QED42OPSIN-59']);
  });
});

describe('prJiraKeys', () => {
  it('extracts from title but not lowercase branch text', () => {
    const pr = {
      repo: 'r',
      number: 1,
      title: 'QED42OPSIN-59: fix thing',
      url: 'http://x',
      state: 'open' as const,
      isDraft: false,
      branch: 'fix/other-77-thing',
      isAuthor: true,
      reviewRequestedOfMe: false,
      reviewState: 'none' as const,
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(prJiraKeys(pr)).toEqual(['QED42OPSIN-59']);
  });
});

describe('extractGitHubPrRefs', () => {
  it('finds a PR URL in plain text', () => {
    expect(extractGitHubPrRefs('PR raised: https://github.com/qed42/operational-intelligence/pull/58')).toEqual([
      { repo: 'qed42/operational-intelligence', number: 58 },
    ]);
  });

  it('returns empty when no GitHub PR URL is present', () => {
    expect(extractGitHubPrRefs('just a regular comment, no link here')).toEqual([]);
  });

  it('dedupes the same PR mentioned twice', () => {
    const text = 'see https://github.com/org/repo/pull/1 — also https://github.com/org/repo/pull/1 again';
    expect(extractGitHubPrRefs(text)).toEqual([{ repo: 'org/repo', number: 1 }]);
  });

  it('merges refs found across multiple texts (description + comments)', () => {
    const description = 'https://github.com/org/repo/pull/1';
    const comment = 'https://github.com/org/repo/pull/2';
    expect(extractGitHubPrRefs(description, comment)).toEqual([
      { repo: 'org/repo', number: 1 },
      { repo: 'org/repo', number: 2 },
    ]);
  });

  it('ignores non-pull-request GitHub URLs', () => {
    expect(extractGitHubPrRefs('see https://github.com/org/repo/issues/9')).toEqual([]);
  });
});
