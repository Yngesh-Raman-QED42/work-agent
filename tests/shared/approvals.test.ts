import { describe, expect, it, afterEach } from 'vitest';
import { createTestDb, type TestDbHandle } from '../../src/test-utils/db.js';
import { ApprovalsStore, type ApprovalInput } from '../../src/shared/approvals.js';

let handle: TestDbHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

function makeEntry(id: string, overrides: Partial<ApprovalInput> = {}): ApprovalInput {
  return {
    id,
    source: 'observation',
    action: 'create_branch_or_pr',
    target: id,
    context: {},
    reasoning: 'x',
    riskLevel: 'low',
    consequenceIfApproved: 'x',
    recommendedAction: 'x',
    ...overrides,
  };
}

describe('ApprovalsStore.reconcile', () => {
  it('deletes a pending approval whose source no longer proposes it — the "PR appeared since" case', async () => {
    handle = await createTestDb();
    const store = new ApprovalsStore(handle.db);
    await store.file(makeEntry('start-pr:PROJ-1'));
    await store.file(makeEntry('start-pr:PROJ-2'));

    // Next run: PROJ-1 now has a PR, so it's no longer proposed; PROJ-2 still is.
    await store.fileMany([makeEntry('start-pr:PROJ-2')]);
    await store.reconcile('observation', ['start-pr:PROJ-2']);

    expect(await store.get('start-pr:PROJ-1')).toBeUndefined();
    const remaining = await store.get('start-pr:PROJ-2');
    expect(remaining?.status).toBe('pending');
  });

  it('deletes every pending approval for a source when nothing is proposed at all', async () => {
    handle = await createTestDb();
    const store = new ApprovalsStore(handle.db);
    await store.file(makeEntry('start-pr:PROJ-1'));

    await store.reconcile('observation', []);

    expect(await store.get('start-pr:PROJ-1')).toBeUndefined();
  });

  it('never touches a different source, or an already-resolved approval', async () => {
    handle = await createTestDb();
    const store = new ApprovalsStore(handle.db);
    await store.file(makeEntry('exec-log-time:PROJ-1', { source: 'engineering_execution', action: 'log_execution_time' }));
    await store.file(makeEntry('start-pr:PROJ-2'));
    await store.resolve('start-pr:PROJ-2', 'approved');

    await store.reconcile('observation', []);

    expect(await store.get('exec-log-time:PROJ-1')).toBeTruthy();
    expect((await store.get('start-pr:PROJ-2'))?.status).toBe('approved');
  });
});
