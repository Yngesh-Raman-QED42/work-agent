import { describe, expect, it, afterEach } from 'vitest';
import { createTestDb, type TestDbHandle } from '../src/test-utils/db.js';
import { runPipeline } from '../src/pipeline/run.js';
import { MockSlackConnector } from '../src/integrations/slack/mock.js';
import { MockJiraConnector } from '../src/integrations/jira/mock.js';
import { MockGitHubConnector, defaultFixturePrs } from '../src/integrations/github/mock.js';
import { AuditLog } from '../src/pipeline/audit.js';
import { ApprovalsStore } from '../src/shared/approvals.js';
import { executionTasks } from '../src/db/schema.js';

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

  it('excludes an explicitly ignored ticket entirely, before correlation or classification ever sees it', async () => {
    handle = await createTestDb();
    const result = await runPipeline(handle.db, mockConnectors(), { runDate: '2026-09-09', ignoredKeys: ['QED42OPSIN-59'] });
    expect(result.items.some((i) => i.id === 'QED42OPSIN-59')).toBe(false);
  });

  it('audit log records how many were ignored, for a real "why is this gone" answer later', async () => {
    handle = await createTestDb();
    await runPipeline(handle.db, mockConnectors(), { runDate: '2026-09-09', ignoredKeys: ['QED42OPSIN-59'] });
    const collected = (await new AuditLog(handle.db).readAll()).find((e) => e.event === 'collected_jira');
    expect((collected!.details as { ignored: number }).ignored).toBe(1);
  });

  it('a "no PR linked yet" approval disappears once a PR shows up for that ticket on a later run', async () => {
    handle = await createTestDb();
    const first = await runPipeline(handle.db, mockConnectors(), { runDate: '2026-09-09' });
    // QGP-463 (Backlog, no PR in the default fixture) should have proposed this.
    expect(first.approvalQueue.some((a) => a.id === 'start-pr:QGP-463')).toBe(true);
    expect((await new ApprovalsStore(handle.db).get('start-pr:QGP-463'))?.status).toBe('pending');

    const prsWithFollowUp = [
      ...defaultFixturePrs(),
      {
        repo: 'qed42/operational-intelligence',
        number: 200,
        title: 'QGP-463: kick off MVP scaffolding',
        url: 'https://github.com/qed42/operational-intelligence/pull/200',
        state: 'open' as const,
        isDraft: false,
        branch: 'work-agent/qgp-463',
        isAuthor: true,
        reviewRequestedOfMe: false,
        reviewState: 'none' as const,
        updatedAt: '2026-09-10T09:00:00+05:30',
      },
    ];
    await runPipeline(
      handle.db,
      { slack: mockConnectors().slack, jira: mockConnectors().jira, github: new MockGitHubConnector(prsWithFollowUp) },
      { runDate: '2026-09-10' },
    );

    expect(await new ApprovalsStore(handle.db).get('start-pr:QGP-463')).toBeUndefined();
  });

  it('drops a "monitoring" execution task once its PR is no longer open — a closed/deleted PR should never look like it\'s still in review', async () => {
    handle = await createTestDb();
    const now = new Date();
    await handle.db.insert(executionTasks).values({
      id: 'QED42OPSIN-60',
      repo: 'qed42/operational-intelligence',
      branch: 'work-agent/qed42opsin-60',
      status: 'monitoring',
      prUrl: 'https://github.com/qed42/operational-intelligence/pull/999', // not in the fixture PR list
      createdAt: now,
      updatedAt: now,
    });
    // A still-open PR the fixtures DO include should survive untouched.
    await handle.db.insert(executionTasks).values({
      id: 'QED42OPSIN-56',
      repo: 'qed42/operational-intelligence',
      branch: 'feature/timesheet-export',
      status: 'monitoring',
      prUrl: 'https://github.com/qed42/operational-intelligence/pull/97',
      createdAt: now,
      updatedAt: now,
    });

    await runPipeline(handle.db, mockConnectors(), { runDate: '2026-09-09' });

    const rows = await handle.db.select().from(executionTasks);
    expect(rows.map((r) => r.id)).toEqual(['QED42OPSIN-56']);
  });

  it('ignores nothing by default — an unrelated key in the list has no effect', async () => {
    handle = await createTestDb();
    const result = await runPipeline(handle.db, mockConnectors(), { runDate: '2026-09-09', ignoredKeys: ['NOT-A-REAL-KEY'] });
    expect(result.items.some((i) => i.id === 'QED42OPSIN-59')).toBe(true);
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
