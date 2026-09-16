import { describe, expect, it, afterEach } from 'vitest';
import { createTestDb, type TestDbHandle } from '../../src/test-utils/db.js';
import { logTime, timeEntriesInRange, formatMinutes } from '../../src/agents/workLog/timeEntry.js';

let handle: TestDbHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

describe('logTime / timeEntriesInRange', () => {
  it('records a real, human-provided entry — nothing is inferred', async () => {
    handle = await createTestDb();
    await logTime(handle.db, { date: '2026-09-10', minutes: 60, jiraKey: 'PROJ-1', note: 'fixed the thing' });
    const entries = await timeEntriesInRange(handle.db, '2026-09-10', '2026-09-10');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.minutes).toBe(60);
    expect(entries[0]!.jiraKey).toBe('PROJ-1');
    expect(entries[0]!.note).toBe('fixed the thing');
  });

  it('rejects a non-positive duration rather than silently logging nothing', async () => {
    handle = await createTestDb();
    await expect(logTime(handle.db, { date: '2026-09-10', minutes: 0 })).rejects.toThrow(/positive/);
    await expect(logTime(handle.db, { date: '2026-09-10', minutes: -5 })).rejects.toThrow(/positive/);
  });

  it('a ticket key is optional — not every logged minute maps to one', async () => {
    handle = await createTestDb();
    await logTime(handle.db, { date: '2026-09-10', minutes: 20 });
    const [entry] = await timeEntriesInRange(handle.db, '2026-09-10', '2026-09-10');
    expect(entry!.jiraKey).toBeNull();
  });

  it('only returns entries within the requested date range', async () => {
    handle = await createTestDb();
    await logTime(handle.db, { date: '2026-09-01', minutes: 10 });
    await logTime(handle.db, { date: '2026-09-10', minutes: 20 });
    await logTime(handle.db, { date: '2026-09-20', minutes: 30 });
    const entries = await timeEntriesInRange(handle.db, '2026-09-05', '2026-09-15');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.minutes).toBe(20);
  });
});

describe('formatMinutes', () => {
  it('formats whole hours', () => expect(formatMinutes(120)).toBe('2h'));
  it('formats minutes only', () => expect(formatMinutes(45)).toBe('45m'));
  it('formats mixed hours and minutes', () => expect(formatMinutes(150)).toBe('2h 30m'));
  it('formats zero as 0m', () => expect(formatMinutes(0)).toBe('0m'));
});
