import { describe, expect, it, afterEach } from 'vitest';
import { createTestDb, type TestDbHandle } from '../../src/test-utils/db.js';
import { syncWorkLogFromAudit, recentWorkLog } from '../../src/agents/workLog/sync.js';
import { AuditLog } from '../../src/pipeline/audit.js';

let handle: TestDbHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

describe('syncWorkLogFromAudit', () => {
  it('maps known event types into work_log rows', async () => {
    handle = await createTestDb();
    const audit = new AuditLog(handle.db);
    await audit.log('execution_task_selected', { key: 'PROJ-1', summary: 'fix a thing' });
    await audit.log('execution_pr_opened', { url: 'http://pr' });
    await audit.log('some_unrelated_event', {});

    const inserted = await syncWorkLogFromAudit(handle.db);
    expect(inserted).toBe(2);

    const rows = await recentWorkLog(handle.db);
    expect(rows.map((r) => r.eventType).sort()).toEqual(['pr_created', 'task_started']);
  });

  it('is idempotent — running twice does not duplicate rows', async () => {
    handle = await createTestDb();
    const audit = new AuditLog(handle.db);
    await audit.log('execution_task_selected', { key: 'PROJ-1' });

    await syncWorkLogFromAudit(handle.db);
    const secondRun = await syncWorkLogFromAudit(handle.db);
    expect(secondRun).toBe(0);

    const rows = await recentWorkLog(handle.db);
    expect(rows).toHaveLength(1);
  });

  it('only syncs new events after a prior sync', async () => {
    handle = await createTestDb();
    const audit = new AuditLog(handle.db);
    await audit.log('execution_task_selected', { key: 'PROJ-1' });
    await syncWorkLogFromAudit(handle.db);

    await audit.log('execution_pr_opened', { url: 'http://pr' });
    const secondRun = await syncWorkLogFromAudit(handle.db);
    expect(secondRun).toBe(1);
  });

  it('never fabricates an event for something that was not logged', async () => {
    handle = await createTestDb();
    await syncWorkLogFromAudit(handle.db);
    expect(await recentWorkLog(handle.db)).toEqual([]);
  });
});
