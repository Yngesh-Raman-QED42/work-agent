import { describe, expect, it, afterEach } from 'vitest';
import { createTestDb, type TestDbHandle } from '../../src/test-utils/db.js';
import { executeApprovedAction } from '../../src/shared/executeApproval.js';
import { MockJiraWorklogWriter } from '../../src/integrations/jira/worklogWriter.js';
import { timeEntriesInRange } from '../../src/agents/workLog/timeEntry.js';
import type { ApprovalRow } from '../../src/shared/approvals.js';

let handle: TestDbHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

function makeApproval(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: 'exec-log-time:PROJ-1',
    source: 'engineering_execution',
    action: 'log_execution_time',
    target: 'PROJ-1',
    targetUrl: null,
    context: { taskKey: 'PROJ-1', minutes: 42 },
    reasoning: 'x',
    riskLevel: 'low',
    consequenceIfApproved: 'x',
    recommendedAction: 'x',
    status: 'pending',
    createdAt: new Date(),
    resolvedAt: null,
    ...overrides,
  };
}

describe('executeApprovedAction', () => {
  it('does nothing for any action other than log_execution_time', async () => {
    handle = await createTestDb();
    const writer = new MockJiraWorklogWriter();
    await executeApprovedAction(handle.db, makeApproval({ action: 'manual_review_no_repo_mapping' }), {
      getWorklogWriter: () => writer,
    });
    expect(writer.logged).toEqual([]);
  });

  it('writes a Jira worklog and a matching local time entry for log_execution_time', async () => {
    handle = await createTestDb();
    const writer = new MockJiraWorklogWriter();
    await executeApprovedAction(handle.db, makeApproval(), { getWorklogWriter: () => writer });

    expect(writer.logged).toEqual([{ key: 'PROJ-1', minutes: 42, comment: 'Logged by Work Agent — autonomous implementation time' }]);

    const today = new Date().toISOString().slice(0, 10);
    const entries = await timeEntriesInRange(handle.db, today, today);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.jiraKey).toBe('PROJ-1');
    expect(entries[0]!.minutes).toBe(42);
  });

  it('never constructs the worklog writer for a non-matching action', async () => {
    handle = await createTestDb();
    let constructed = false;
    await executeApprovedAction(handle.db, makeApproval({ action: 'manual_review_failed_gate' }), {
      getWorklogWriter: () => {
        constructed = true;
        return new MockJiraWorklogWriter();
      },
    });
    expect(constructed).toBe(false);
  });

  it('throws on invalid context instead of silently doing nothing', async () => {
    handle = await createTestDb();
    const writer = new MockJiraWorklogWriter();
    await expect(
      executeApprovedAction(handle.db, makeApproval({ context: { taskKey: 'PROJ-1' } }), { getWorklogWriter: () => writer }),
    ).rejects.toThrow(/invalid context/);
    expect(writer.logged).toEqual([]);
  });
});
