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

  it('writes a Jira worklog (with an explicit date, matching the ad-hoc log-time path) and a matching local time entry', async () => {
    handle = await createTestDb();
    const writer = new MockJiraWorklogWriter();
    await executeApprovedAction(handle.db, makeApproval(), { getWorklogWriter: () => writer });

    const today = new Date().toISOString().slice(0, 10);
    expect(writer.logged).toEqual([
      { key: 'PROJ-1', minutes: 42, comment: 'Work Agent autonomously implemented this ticket.', date: today },
    ]);

    const entries = await timeEntriesInRange(handle.db, today, today);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.jiraKey).toBe('PROJ-1');
    expect(entries[0]!.minutes).toBe(42);
  });

  it('builds a contextual worklog comment from the ticket summary, work summary, and PR url when present', async () => {
    handle = await createTestDb();
    const writer = new MockJiraWorklogWriter();
    await executeApprovedAction(
      handle.db,
      makeApproval({
        context: {
          taskKey: 'PROJ-1',
          minutes: 42,
          taskSummary: 'Fix overlapping allocation labels',
          workSummary: 'Added bg-surface-muted to the sticky label div',
          prUrl: 'https://github.com/org/repo/pull/62',
        },
      }),
      { getWorklogWriter: () => writer },
    );

    expect(writer.logged[0]!.comment).toBe(
      'Work Agent autonomously implemented this ticket: Fix overlapping allocation labels. ' +
        'Summary of changes: Added bg-surface-muted to the sticky label div. ' +
        'PR: https://github.com/org/repo/pull/62',
    );
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
