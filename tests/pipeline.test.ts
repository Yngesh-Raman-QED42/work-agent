import { describe, expect, it, afterEach } from 'vitest';
import { createTestDb, type TestDbHandle } from '../src/test-utils/db.js';
import { runPipeline } from '../src/pipeline/run.js';
import { MockSlackConnector } from '../src/integrations/slack/mock.js';
import { MockJiraConnector } from '../src/integrations/jira/mock.js';
import { MockGitHubConnector } from '../src/integrations/github/mock.js';
import { AuditLog } from '../src/pipeline/audit.js';

let handle: TestDbHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

function mockConnectors() {
  return { slack: new MockSlackConnector(), jira: new MockJiraConnector(), github: new MockGitHubConnector() };
}

describe('runPipeline (end to end, mocked connectors)', () => {
  it('produces work items, a briefing, and an approval queue', async () => {
    handle = await createTestDb();
    const result = await runPipeline(handle.db, mockConnectors(), { runDate: '2026-09-09' });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.briefing).toContain('2026-09-09');
    expect(result.approvalQueue.length).toBeGreaterThan(0);
  });

  it('briefing mentions a known fixture ticket', async () => {
    handle = await createTestDb();
    const result = await runPipeline(handle.db, mockConnectors(), { runDate: '2026-09-09' });
    expect(result.briefing).toContain('QED42OPSIN-59');
  });

  it('audit log records the full run sequence', async () => {
    handle = await createTestDb();
    await runPipeline(handle.db, mockConnectors(), { runDate: '2026-09-09' });
    const events = (await new AuditLog(handle.db).readAll()).map((e) => e.event);
    expect(events).toEqual([
      'run_started',
      'collected_slack',
      'collected_jira',
      'collected_github',
      'correlated',
      'classified',
      'state_updated',
      'briefing_generated',
      'approval_queue_generated',
      'run_completed',
    ]);
  });

  it('first run: everything is new', async () => {
    handle = await createTestDb();
    const result = await runPipeline(handle.db, mockConnectors(), { runDate: '2026-09-09' });
    const ids = new Set(result.items.map((i) => i.id));
    expect(new Set(result.diff.newItems)).toEqual(ids);
    expect(result.diff.resolved).toEqual([]);
    expect(result.diff.changed).toEqual([]);
  });

  it('second run with unchanged fixtures: nothing new or resolved', async () => {
    handle = await createTestDb();
    await runPipeline(handle.db, mockConnectors(), { runDate: '2026-09-09' });
    const result2 = await runPipeline(handle.db, mockConnectors(), { runDate: '2026-09-10' });
    expect(result2.diff.newItems).toEqual([]);
    expect(result2.diff.resolved).toEqual([]);
    expect(result2.diff.changed).toEqual([]);
  });

  it('state persists in the work_items table between runs', async () => {
    handle = await createTestDb();
    await runPipeline(handle.db, mockConnectors(), { runDate: '2026-09-09' });
    const rows = await handle.db.query.workItems.findMany();
    expect(rows.some((r) => r.jiraKey === 'QED42OPSIN-59')).toBe(true);
  });

  it('no mock connector exposes a write method', () => {
    const forbidden = /^(post|send|update|edit|delete|create|transition|merge|push)/i;
    for (const connector of [new MockSlackConnector(), new MockJiraConnector(), new MockGitHubConnector()]) {
      const proto = Object.getPrototypeOf(connector);
      for (const name of Object.getOwnPropertyNames(proto)) {
        expect(forbidden.test(name), `${connector.constructor.name}.${name} looks like a write method`).toBe(false);
      }
    }
  });
});
