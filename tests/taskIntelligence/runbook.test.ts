import { describe, expect, it, afterEach } from 'vitest';
import { createTestDb, type TestDbHandle } from '../../src/test-utils/db.js';
import { assessAssignment } from '../../src/agents/taskIntelligence/runbook.js';
import { AutonomyPolicy } from '../../src/agents/engineeringExecution/policy.js';
import { MockJiraDetailReader } from '../../src/integrations/jira/mock.js';
import type { TaskContext } from '../../src/integrations/jira/detail.js';
import { ApprovalsStore } from '../../src/shared/approvals.js';

let handle: TestDbHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

function makeTask(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    key: 'PROJ-1',
    project: 'PROJ',
    summary: 'Fix a thing',
    description: 'd'.repeat(150),
    issueType: 'Task',
    status: 'To Do',
    priority: 'Medium',
    url: 'http://x/PROJ-1',
    comments: [],
    ...overrides,
  };
}

const signal = { channel: 'C1', ts: '1.0', text: '@you can you take PROJ-1?' };

describe('assessAssignment', () => {
  it('a clear, policy-eligible ticket is ready for execution', async () => {
    handle = await createTestDb();
    const reader = new MockJiraDetailReader({ 'PROJ-1': makeTask() });
    const result = await assessAssignment({ db: handle.db, policy: new AutonomyPolicy(), detailReader: reader }, 'PROJ-1', signal);
    expect(result.outcome).toBe('ready_for_execution');
  });

  it('an ambiguous ticket (e.g. touches permissions) is flagged, not silently started', async () => {
    handle = await createTestDb();
    const reader = new MockJiraDetailReader({
      'PROJ-1': makeTask({ description: 'This requires changing the admin permission model. '.repeat(3) }),
    });
    const result = await assessAssignment({ db: handle.db, policy: new AutonomyPolicy(), detailReader: reader }, 'PROJ-1', signal);
    expect(result.outcome).toBe('ambiguous');
    const pending = await new ApprovalsStore(handle.db).listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.action).toBe('clarify_task_assignment');
  });

  it('a ticket that cannot be fetched is flagged as not found, never guessed at', async () => {
    handle = await createTestDb();
    const reader = new MockJiraDetailReader({});
    const result = await assessAssignment({ db: handle.db, policy: new AutonomyPolicy(), detailReader: reader }, 'MISSING-1', signal);
    expect(result.outcome).toBe('no_ticket_found');
    const pending = await new ApprovalsStore(handle.db).listPending();
    expect(pending[0]!.action).toBe('manual_review_ticket_not_found');
  });

  it('works for any project key, nothing hardcoded', async () => {
    handle = await createTestDb();
    const reader = new MockJiraDetailReader({ 'NEWPROJ-7': makeTask({ key: 'NEWPROJ-7', project: 'NEWPROJ' }) });
    const result = await assessAssignment({ db: handle.db, policy: new AutonomyPolicy(), detailReader: reader }, 'NEWPROJ-7', signal);
    expect(result.outcome).toBe('ready_for_execution');
  });
});
