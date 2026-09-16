import { describe, expect, it } from 'vitest';
import { generateBriefing } from '../src/pipeline/briefing.js';
import type { WorkItem, Category, Urgency } from '../src/models/types.js';
import type { StateDiff } from '../src/pipeline/state.js';

function emptyDiff(): StateDiff {
  return { newItems: [], resolved: [], changed: [], unchanged: [] };
}

function makeItem(id: string, category: Category, urgency: Urgency): WorkItem {
  return {
    id,
    jira: {
      key: id,
      project: 'ABC',
      summary: `summary ${id}`,
      status: 'To Do',
      statusCategory: 'To Do',
      priority: 'Medium',
      updated: '2026-01-01T00:00:00Z',
      url: 'http://x',
    },
    prs: [],
    slackMessages: [],
    category,
    urgency,
    reasons: [`reason for ${id}`],
  };
}

describe('generateBriefing', () => {
  it('includes run date and counts', () => {
    const text = generateBriefing([makeItem('ABC-1', 'needs_review', 'high')], { ...emptyDiff(), newItems: ['ABC-1'] }, '2026-09-09');
    expect(text).toContain('2026-09-09');
    expect(text).toContain('Tracking **1** work items');
  });

  it('groups by category with titles', () => {
    const items = [makeItem('ABC-1', 'needs_review', 'high'), makeItem('ABC-2', 'fyi', 'low')];
    const text = generateBriefing(items, emptyDiff(), '2026-09-09');
    expect(text).toContain('## Needs your review');
    expect(text).toContain('## FYI');
  });

  it('shows the NEW flag', () => {
    const text = generateBriefing([makeItem('ABC-1', 'fyi', 'low')], { ...emptyDiff(), newItems: ['ABC-1'] }, '2026-09-09');
    expect(text).toContain('[NEW]');
  });

  it('shows a resolved section', () => {
    const text = generateBriefing([], { ...emptyDiff(), resolved: ['ABC-9'] }, '2026-09-09');
    expect(text).toContain('## Resolved since last run');
    expect(text).toContain('ABC-9');
  });

  it('omits category sections when there are no items', () => {
    expect(generateBriefing([], emptyDiff(), '2026-09-09')).not.toContain('## FYI');
  });

  it('sorts high urgency before low', () => {
    const items = [makeItem('ABC-2', 'fyi', 'low'), makeItem('ABC-1', 'fyi', 'high')];
    const text = generateBriefing(items, emptyDiff(), '2026-09-09');
    expect(text.indexOf('ABC-1')).toBeLessThan(text.indexOf('ABC-2'));
  });
});
