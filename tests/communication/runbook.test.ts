import { describe, expect, it, afterEach } from 'vitest';
import { createTestDb, type TestDbHandle } from '../../src/test-utils/db.js';
import { draftAndRoute, sendApprovedCommunication } from '../../src/agents/communication/runbook.js';
import { TemplateMessageDrafter } from '../../src/agents/communication/drafter.js';
import { MockSlackSender } from '../../src/agents/communication/sender.js';
import { ApprovalsStore } from '../../src/shared/approvals.js';

let handle: TestDbHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

const routineContext = { channel: 'C1', channelName: '#eng', threadTs: '1.0', incomingText: 'hey can you check this?' };
const consequentialContext = { channel: 'C1', channelName: '#eng', threadTs: '1.0', incomingText: "I'll ship this by Friday for the client" };

describe('draftAndRoute', () => {
  it('a routine draft is queued for approval when autoSendRoutine is off (default)', async () => {
    handle = await createTestDb();
    const sender = new MockSlackSender();
    const result = await draftAndRoute(
      { db: handle.db, drafter: new TemplateMessageDrafter(), sender, autoSendRoutine: false },
      routineContext,
    );
    expect(result.outcome).toBe('queued_for_approval');
    expect(sender.calls).toEqual([]);
    expect(await new ApprovalsStore(handle.db).listPending()).toHaveLength(1);
  });

  it('a routine draft auto-sends only when explicitly enabled', async () => {
    handle = await createTestDb();
    const sender = new MockSlackSender();
    const result = await draftAndRoute(
      { db: handle.db, drafter: new TemplateMessageDrafter(), sender, autoSendRoutine: true },
      routineContext,
    );
    expect(result.outcome).toBe('auto_sent');
    expect(sender.calls).toHaveLength(1);
  });

  it('a consequential draft is NEVER auto-sent even with autoSendRoutine enabled', async () => {
    handle = await createTestDb();
    const sender = new MockSlackSender();
    const result = await draftAndRoute(
      { db: handle.db, drafter: new TemplateMessageDrafter(), sender, autoSendRoutine: true },
      consequentialContext,
    );
    expect(result.outcome).toBe('queued_for_approval');
    expect(sender.calls).toEqual([]);
    const pending = await new ApprovalsStore(handle.db).listPending();
    expect(pending[0]!.riskLevel).toBe('high');
  });

  it('sendApprovedCommunication sends exactly the approved draft, only after approval', async () => {
    handle = await createTestDb();
    const sender = new MockSlackSender();
    const approvals = new ApprovalsStore(handle.db);
    await draftAndRoute({ db: handle.db, drafter: new TemplateMessageDrafter(), sender, autoSendRoutine: false }, routineContext);
    const [pending] = await approvals.listPending();

    await expect(sendApprovedCommunication(handle.db, sender, pending!.id)).rejects.toThrow(/not in "approved" status/);
    expect(sender.calls).toEqual([]);

    await approvals.resolve(pending!.id, 'approved');
    await sendApprovedCommunication(handle.db, sender, pending!.id);
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]!.channel).toBe('C1');
  });
});
