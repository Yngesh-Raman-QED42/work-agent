import { describe, expect, it, afterEach } from 'vitest';
import { createTestDb, type TestDbHandle } from '../src/test-utils/db.js';
import { AuditLog } from '../src/pipeline/audit.js';

let handle: TestDbHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

describe('AuditLog', () => {
  it('records an entry with expected fields', async () => {
    handle = await createTestDb();
    const audit = new AuditLog(handle.db);
    await audit.log('run_started', { mode: 'mock' });
    const entries = await audit.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.event).toBe('run_started');
    expect(entries[0]!.details).toEqual({ mode: 'mock' });
  });

  it('appends multiple entries in order, never overwrites', async () => {
    handle = await createTestDb();
    const audit = new AuditLog(handle.db);
    await audit.log('a', {});
    await audit.log('b', {});
    const entries = await audit.readAll();
    expect(entries.map((e) => e.event)).toEqual(['a', 'b']);
  });

  it('readAll on an empty log returns empty', async () => {
    handle = await createTestDb();
    const audit = new AuditLog(handle.db);
    expect(await audit.readAll()).toEqual([]);
  });
});
