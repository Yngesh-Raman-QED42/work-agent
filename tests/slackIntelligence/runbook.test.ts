import { describe, expect, it, afterEach } from 'vitest';
import { createTestDb, type TestDbHandle } from '../../src/test-utils/db.js';
import { runSlackIntelligence } from '../../src/agents/slackIntelligence/runbook.js';
import type { SlackMessage } from '../../src/models/types.js';

let handle: TestDbHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

function makeMsg(text: string, mentionsMe = false, ts = '1.0'): SlackMessage {
  return { channel: 'C1', channelName: '#eng', ts, user: 'U1', text, permalink: 'x', mentionsMe };
}

describe('runSlackIntelligence', () => {
  it('persists only relevant categories, not irrelevant/informational noise', async () => {
    handle = await createTestDb();
    const messages = [
      makeMsg('lunch at 1pm?', false, '1.0'),
      makeMsg('@you can you take this one?', true, '2.0'),
    ];
    const result = await runSlackIntelligence(handle.db, messages);
    expect(result.persisted).toHaveLength(1);
    expect(result.persisted[0]!.category).toBe('task_assignment');
  });

  it('builds a non-empty summary when there is signal', async () => {
    handle = await createTestDb();
    const result = await runSlackIntelligence(handle.db, [makeMsg('@you can you take this one?', true)]);
    expect(result.summary).toContain('New task assignments');
  });

  it('reports no signal when everything is noise', async () => {
    handle = await createTestDb();
    const result = await runSlackIntelligence(handle.db, [makeMsg('lunch?')]);
    expect(result.summary).toBe('No Slack signal needing attention.');
  });

  it('writes rows into slack_signals for persisted categories', async () => {
    handle = await createTestDb();
    await runSlackIntelligence(handle.db, [makeMsg('@you can you take this one?', true)]);
    const rows = await handle.db.query.slackSignals.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.category).toBe('task_assignment');
  });

  it('removes a signal on the next run once it is no longer in the fetched window — never stays "current" forever', async () => {
    handle = await createTestDb();
    await runSlackIntelligence(handle.db, [makeMsg('@you can you take this one?', true, '1.0')]);
    expect(await handle.db.query.slackSignals.findMany()).toHaveLength(1);

    // Next run's 24h fetch no longer includes that message at all (it aged
    // out, or got resolved) — a fresh message is the only thing persisted.
    await runSlackIntelligence(handle.db, [makeMsg('@you new thing, can you take this?', true, '2.0')]);
    const rows = await handle.db.query.slackSignals.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('C1:2.0');
  });

  it('clears every persisted signal when a run finds nothing relevant at all', async () => {
    handle = await createTestDb();
    await runSlackIntelligence(handle.db, [makeMsg('@you can you take this one?', true)]);
    expect(await handle.db.query.slackSignals.findMany()).toHaveLength(1);

    await runSlackIntelligence(handle.db, [makeMsg('lunch at 1pm?')]);
    expect(await handle.db.query.slackSignals.findMany()).toHaveLength(0);
  });
});
