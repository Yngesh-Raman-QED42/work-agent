import { describe, expect, it, afterEach } from 'vitest';
import { createTestDb, type TestDbHandle } from '../../src/test-utils/db.js';
import { generateWeeklySummary } from '../../src/agents/weeklySummary/runbook.js';
import { AuditLog } from '../../src/pipeline/audit.js';
import { logTime } from '../../src/agents/workLog/timeEntry.js';

let handle: TestDbHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

describe('generateWeeklySummary', () => {
  it('never infers hours from activity when nothing was manually logged', async () => {
    handle = await createTestDb();
    const audit = new AuditLog(handle.db);
    await audit.log('execution_pr_opened', { url: 'http://pr' }); // real activity, but no time logged against it
    const result = await generateWeeklySummary(handle.db, '2026-09-09');
    expect(result.content.toLowerCase()).not.toMatch(/\d+\s*(hours|hrs)\b/);
    expect(result.content).toContain('No hours logged this week');
  });

  it('reports real hours once manually logged, grouped by ticket', async () => {
    handle = await createTestDb();
    const today = new Date().toISOString().slice(0, 10);
    await logTime(handle.db, { date: today, minutes: 90, jiraKey: 'PROJ-1' });
    await logTime(handle.db, { date: today, minutes: 30, jiraKey: 'PROJ-1' });
    await logTime(handle.db, { date: today, minutes: 45, jiraKey: 'PROJ-2' });

    const result = await generateWeeklySummary(handle.db, '2026-09-09');
    expect(result.content).toContain('2h 45m');
    expect(result.content).toContain('PROJ-1: 2h');
    expect(result.content).toContain('PROJ-2: 45m');
  });

  it('never invents a duration even when activity exists but no time was logged for it', async () => {
    handle = await createTestDb();
    const audit = new AuditLog(handle.db);
    await audit.log('execution_pr_opened', { url: 'http://pr' });
    await audit.log('execution_checks_run', { results: [] });
    const result = await generateWeeklySummary(handle.db, '2026-09-09');
    // activity is reported as counts, never converted into a time figure
    expect(result.content).toContain('pr_created: 1');
    expect(result.content).not.toMatch(/pr_created.*\d+\s*(m|h|min|hour)/i);
  });

  it('groups activity by event type', async () => {
    handle = await createTestDb();
    const audit = new AuditLog(handle.db);
    await audit.log('execution_task_selected', { key: 'PROJ-1' });
    await audit.log('execution_pr_opened', { url: 'http://pr' });
    const result = await generateWeeklySummary(handle.db, '2026-09-09');
    expect(result.content).toContain('task_started: 1');
    expect(result.content).toContain('pr_created: 1');
  });

  it('lists tickets with tracked activity when a key is present', async () => {
    handle = await createTestDb();
    const audit = new AuditLog(handle.db);
    await audit.log('execution_task_selected', { key: 'PROJ-7' });
    const result = await generateWeeklySummary(handle.db, '2026-09-09');
    expect(result.content).toContain('PROJ-7');
  });

  it('persists the briefing under kind weekly', async () => {
    handle = await createTestDb();
    await generateWeeklySummary(handle.db, '2026-09-09');
    const rows = await handle.db.query.briefings.findMany();
    expect(rows.some((r) => r.kind === 'weekly')).toBe(true);
  });
});
