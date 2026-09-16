import { describe, expect, it, afterEach } from 'vitest';
import { createTestDb, type TestDbHandle } from '../src/test-utils/db.js';
import { diffState, loadPrevious, saveCurrent } from '../src/pipeline/state.js';
import type { WorkItem } from '../src/models/types.js';

let handle: TestDbHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

function makeItem(id: string, category = 'fyi', urgency = 'low'): WorkItem {
  return {
    id,
    jira: {
      key: id,
      project: 'ABC',
      summary: 's',
      status: 'To Do',
      statusCategory: 'To Do',
      priority: 'Low',
      updated: '2026-01-01T00:00:00Z',
      url: 'http://x',
    },
    prs: [],
    slackMessages: [],
    category: category as WorkItem['category'],
    urgency: urgency as WorkItem['urgency'],
    reasons: [],
  };
}

describe('state store', () => {
  it('round-trips through save/load', async () => {
    handle = await createTestDb();
    await saveCurrent(handle.db, [makeItem('ABC-1')]);
    const previous = await loadPrevious(handle.db);
    expect(previous.get('ABC-1')?.category).toBe('fyi');
  });

  it('detects a new item with empty previous state', async () => {
    const diff = diffState(new Map(), [makeItem('ABC-1')]);
    expect(diff.newItems).toEqual(['ABC-1']);
    expect(diff.resolved).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it('detects a resolved item', () => {
    const previous = new Map([['ABC-1', { id: 'ABC-1', category: 'fyi', urgency: 'low' }]]);
    const diff = diffState(previous, []);
    expect(diff.resolved).toEqual(['ABC-1']);
  });

  it('detects a changed category', () => {
    const previous = new Map([['ABC-1', { id: 'ABC-1', category: 'fyi', urgency: 'low' }]]);
    const diff = diffState(previous, [makeItem('ABC-1', 'needs_action')]);
    expect(diff.changed).toEqual(['ABC-1']);
    expect(diff.unchanged).toEqual([]);
  });

  it('detects an unchanged item', () => {
    const previous = new Map([['ABC-1', { id: 'ABC-1', category: 'fyi', urgency: 'low' }]]);
    const diff = diffState(previous, [makeItem('ABC-1', 'fyi', 'low')]);
    expect(diff.unchanged).toEqual(['ABC-1']);
    expect(diff.changed).toEqual([]);
  });
});
