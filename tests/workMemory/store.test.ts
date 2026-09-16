import { describe, expect, it, afterEach } from 'vitest';
import { createTestDb, type TestDbHandle } from '../../src/test-utils/db.js';
import { WorkMemoryStore } from '../../src/agents/workMemory/store.js';

let handle: TestDbHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

describe('WorkMemoryStore', () => {
  it('distinguishes a fact from an AI conclusion', async () => {
    handle = await createTestDb();
    const store = new WorkMemoryStore(handle.db);
    await store.recordFact({ subject: 'PROJ-1', content: { status: 'In Progress' }, sourceSystem: 'jira', sourceRef: 'http://x' });
    await store.recordConclusion({ subject: 'PROJ-1', content: { assessment: 'likely blocked on review' } });

    const rows = await store.forSubject('PROJ-1');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.kind === 'fact')?.sourceSystem).toBe('jira');
    expect(rows.find((r) => r.kind === 'conclusion')?.sourceSystem).toBe('ai');
  });

  it('search finds by subject substring', async () => {
    handle = await createTestDb();
    const store = new WorkMemoryStore(handle.db);
    await store.recordFact({ subject: 'PROJ-42', content: {}, sourceSystem: 'jira' });
    await store.recordFact({ subject: 'OTHER-1', content: {}, sourceSystem: 'jira' });

    const results = await store.search('PROJ');
    expect(results).toHaveLength(1);
    expect(results[0]!.subject).toBe('PROJ-42');
  });

  it('records observedAt and sourceRef for traceability', async () => {
    handle = await createTestDb();
    const store = new WorkMemoryStore(handle.db);
    const observedAt = new Date('2026-01-01T00:00:00Z');
    await store.recordFact({ subject: 'PROJ-1', content: {}, sourceSystem: 'github', sourceRef: 'https://github.com/x/y/pull/1', observedAt });

    const [row] = await store.forSubject('PROJ-1');
    expect(row!.sourceRef).toBe('https://github.com/x/y/pull/1');
    expect(row!.observedAt.toISOString()).toBe(observedAt.toISOString());
  });
});
