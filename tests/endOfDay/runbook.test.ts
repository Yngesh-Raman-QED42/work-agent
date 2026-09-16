import { describe, expect, it, afterEach } from 'vitest';
import { createTestDb, type TestDbHandle } from '../../src/test-utils/db.js';
import { generateEndOfDay } from '../../src/agents/endOfDay/runbook.js';
import { AuditLog } from '../../src/pipeline/audit.js';
import { ApprovalsStore } from '../../src/shared/approvals.js';
import { logTime } from '../../src/agents/workLog/timeEntry.js';

let handle: TestDbHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

describe('generateEndOfDay', () => {
  it('reports no activity honestly when nothing happened', async () => {
    handle = await createTestDb();
    const result = await generateEndOfDay(handle.db, '2026-09-09');
    expect(result.content).toContain('No work activity was logged today');
  });

  it('summarizes today\'s real events', async () => {
    handle = await createTestDb();
    const audit = new AuditLog(handle.db);
    await audit.log('execution_pr_opened', { url: 'http://pr' });
    const result = await generateEndOfDay(handle.db, new Date().toISOString().slice(0, 10));
    expect(result.content).toContain('pr_created: 1');
  });

  it('lists open approvals', async () => {
    handle = await createTestDb();
    await new ApprovalsStore(handle.db).file({
      id: 'a1',
      source: 'observation',
      action: 'review_pull_request',
      target: 'org/repo#1',
      context: {},
      reasoning: 'x',
      riskLevel: 'low',
      consequenceIfApproved: 'x',
      recommendedAction: 'review it',
    });
    const result = await generateEndOfDay(handle.db, '2026-09-09');
    expect(result.content).toContain('review_pull_request');
  });

  it('shows logged time for the day, real minutes only', async () => {
    handle = await createTestDb();
    const today = new Date().toISOString().slice(0, 10);
    await logTime(handle.db, { date: today, minutes: 90, jiraKey: 'PROJ-1' });
    const result = await generateEndOfDay(handle.db, today);
    expect(result.content).toContain('1h 30m');
    expect(result.content).toContain('PROJ-1');
  });

  it('is honest when nothing was logged, rather than guessing', async () => {
    handle = await createTestDb();
    const result = await generateEndOfDay(handle.db, '2026-09-09');
    expect(result.content).toContain('None logged yet');
  });

  it('persists the briefing under kind end_of_day', async () => {
    handle = await createTestDb();
    await generateEndOfDay(handle.db, '2026-09-09');
    const rows = await handle.db.query.briefings.findMany();
    expect(rows.some((r) => r.kind === 'end_of_day' && r.runDate === '2026-09-09')).toBe(true);
  });
});
