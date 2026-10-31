import { describe, expect, it } from 'vitest';
import { extractJiraKeys, slackMessageJiraKeys, prJiraKeys, extractGitHubPrRefs, extractFigmaRefs } from '../src/models/types.js';

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

describe('extractFigmaRefs', () => {
  it('finds a design link with a specific frame (node-id), normalizing the dash to a colon for the API', () => {
    const text = 'Build this: https://www.figma.com/design/ABC123/My-File?node-id=12-345&t=xyz';
    expect(extractFigmaRefs(text)).toEqual([
      { fileKey: 'ABC123', nodeId: '12:345', url: 'https://www.figma.com/design/ABC123/My-File?node-id=12-345&t=xyz' },
    ]);
  });

  it('finds a whole-file link with no node-id — still a ref, just not renderable as one frame', () => {
    const refs = extractFigmaRefs('see https://figma.com/file/ABC123/My-File');
    expect(refs).toEqual([{ fileKey: 'ABC123', nodeId: undefined, url: 'https://figma.com/file/ABC123/My-File' }]);
  });

  it('handles the already-colon-encoded node-id form some Figma links use (node-id=12%3A345)', () => {
    const refs = extractFigmaRefs('https://figma.com/design/ABC123/x?node-id=12%3A345');
    expect(refs[0]!.nodeId).toBe('12:345');
  });

  it('returns empty when no Figma URL is present', () => {
    expect(extractFigmaRefs('just a regular ticket, no design link')).toEqual([]);
  });

  it('dedupes the same file+node mentioned twice', () => {
    const text = 'see https://figma.com/design/ABC/x?node-id=1-1 — also https://figma.com/design/ABC/x?node-id=1-1 again';
    expect(extractFigmaRefs(text)).toHaveLength(1);
  });

  it('keeps desktop and mobile frames from the same file as two distinct refs', () => {
    const desc = 'Desktop: https://figma.com/design/ABC/x?node-id=1-1';
    const comment = 'Mobile: https://figma.com/design/ABC/x?node-id=2-2';
    const refs = extractFigmaRefs(desc, comment);
    expect(refs).toEqual([
      { fileKey: 'ABC', nodeId: '1:1', url: 'https://figma.com/design/ABC/x?node-id=1-1' },
      { fileKey: 'ABC', nodeId: '2:2', url: 'https://figma.com/design/ABC/x?node-id=2-2' },
    ]);
  });

  it('merges refs found across description + comments', () => {
    const refs = extractFigmaRefs('https://figma.com/design/AAA/x', 'https://figma.com/design/BBB/y');
    expect(refs.map((r) => r.fileKey)).toEqual(['AAA', 'BBB']);
  });
});
