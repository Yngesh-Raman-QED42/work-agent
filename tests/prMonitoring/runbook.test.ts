import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, type TestDbHandle } from '../../src/test-utils/db.js';
import { monitorPr } from '../../src/agents/prMonitoring/runbook.js';
import { MockPrStatusReader } from '../../src/agents/prMonitoring/githubReader.js';
import { MockClaudeCodeRunner, type RunOutcome } from '../../src/agents/engineeringExecution/claudeRunner.js';
import { MockGitOps } from '../../src/agents/engineeringExecution/gitOps.js';
import { WorktreeManager } from '../../src/agents/engineeringExecution/worktree.js';
import type { PrStatus, ReviewComment } from '../../src/agents/prMonitoring/models.js';
import { ApprovalsStore } from '../../src/shared/approvals.js';
import { AuditLog } from '../../src/pipeline/audit.js';

const NOOP_CHECKS: Array<[string, string[]]> = [['noop', ['true']]];

function makePr(overrides: Partial<PrStatus> = {}): PrStatus {
  return {
    repo: 'org/repo',
    number: 42,
    url: 'https://github.com/org/repo/pull/42',
    branch: 'feature/x',
    state: 'open',
    mergeable: true,
    ciStatus: 'success',
    reviewState: 'changes_requested',
    comments: [],
    ...overrides,
  };
}

function makeComment(body: string, overrides: Partial<ReviewComment> = {}): ReviewComment {
  return { id: '1', author: 'reviewer', body, url: 'http://x', resolved: false, ...overrides };
}

class FakeWorktreeManager extends WorktreeManager {
  constructor() {
    super('unused');
  }
  override async createForBranch(nameHint: string): Promise<string> {
    return mkdtempSync(join(tmpdir(), `${nameHint}-`));
  }
}

let handle: TestDbHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

describe('monitorPr', () => {
  it('closed PR: no action', async () => {
    handle = await createTestDb();
    const result = await monitorPr({
      db: handle.db,
      repo: 'org/repo',
      number: 42,
      reader: new MockPrStatusReader(makePr({ state: 'closed' })),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps: new MockGitOps(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      repoLocalPath: '/x',
    });
    expect(result.outcome).toBe('no_action_needed');
  });

  it('nothing to address: no action', async () => {
    handle = await createTestDb();
    const result = await monitorPr({
      db: handle.db,
      repo: 'org/repo',
      number: 42,
      reader: new MockPrStatusReader(makePr({ comments: [], ciStatus: 'success' })),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps: new MockGitOps(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      repoLocalPath: '/x',
    });
    expect(result.outcome).toBe('no_action_needed');
  });

  it('CI failing with no comments escalates', async () => {
    handle = await createTestDb();
    const result = await monitorPr({
      db: handle.db,
      repo: 'org/repo',
      number: 42,
      reader: new MockPrStatusReader(makePr({ comments: [], ciStatus: 'failure' })),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps: new MockGitOps(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      repoLocalPath: '/x',
    });
    expect(result.outcome).toBe('escalated');
    expect(await new ApprovalsStore(handle.db).listPending()).toHaveLength(1);
  });

  it('an architectural comment escalates without touching git', async () => {
    handle = await createTestDb();
    const gitOps = new MockGitOps();
    const result = await monitorPr({
      db: handle.db,
      repo: 'org/repo',
      number: 42,
      reader: new MockPrStatusReader(makePr({ comments: [makeComment('why did you architect this as a separate module?')] })),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps,
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      repoLocalPath: '/x',
    });
    expect(result.outcome).toBe('escalated');
    expect(gitOps.calls).toEqual([]);
    const pending = await new ApprovalsStore(handle.db).listPending();
    expect(pending[0]!.action).toBe('respond_to_review_feedback');
  });

  it('a straightforward-only comment set triggers an auto-fix push, no new PR', async () => {
    handle = await createTestDb();
    const gitOps = new MockGitOps();
    const result = await monitorPr({
      db: handle.db,
      repo: 'org/repo',
      number: 42,
      reader: new MockPrStatusReader(makePr({ comments: [makeComment('typo: fix "recieve" to "receive"')] })),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps,
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      repoLocalPath: '/x',
      checkCommands: NOOP_CHECKS,
    });
    expect(result.outcome).toBe('auto_fix_pushed');
    expect(gitOps.calls.some((c) => c[0] === 'push' && c[2] === 'feature/x')).toBe(true);
    expect(gitOps.calls.some((c) => c[0] === 'createBranch')).toBe(false); // no new branch — same PR branch
  });

  it('mixed feedback (one straightforward, one escalate) escalates the whole thing', async () => {
    handle = await createTestDb();
    const result = await monitorPr({
      db: handle.db,
      repo: 'org/repo',
      number: 42,
      reader: new MockPrStatusReader(
        makePr({
          comments: [makeComment('typo: fix spelling'), makeComment('this changes the public API, why?')],
        }),
      ),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps: new MockGitOps(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      repoLocalPath: '/x',
    });
    expect(result.outcome).toBe('escalated');
  });

  it('failing checks after a straightforward fix stop before push', async () => {
    handle = await createTestDb();
    const gitOps = new MockGitOps();
    const result = await monitorPr({
      db: handle.db,
      repo: 'org/repo',
      number: 42,
      reader: new MockPrStatusReader(makePr({ comments: [makeComment('please add a test for this')] })),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps,
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      repoLocalPath: '/x',
      checkCommands: [['test', ['false']]],
      checkRetries: 0, // a real failure, not flakiness — skip the retry delay
    });
    expect(result.outcome).toBe('stopped_failed_checks');
    expect(gitOps.calls.some((c) => c[0] === 'push')).toBe(false);
  });

  it('implementer stopping itself escalates', async () => {
    handle = await createTestDb();
    const outcome: RunOutcome = { success: false, summary: 'this feedback is ambiguous, stopping' };
    const result = await monitorPr({
      db: handle.db,
      repo: 'org/repo',
      number: 42,
      reader: new MockPrStatusReader(makePr({ comments: [makeComment('please add a test for this')] })),
      claudeRunner: new MockClaudeCodeRunner(outcome),
      gitOps: new MockGitOps(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      repoLocalPath: '/x',
    });
    expect(result.outcome).toBe('escalated');
  });

  it('never pushes a feedback fix that was not run through /code-review', async () => {
    handle = await createTestDb();
    const gitOps = new MockGitOps();
    const result = await monitorPr({
      db: handle.db,
      repo: 'org/repo',
      number: 42,
      reader: new MockPrStatusReader(makePr({ comments: [makeComment('typo: fix spelling')] })),
      claudeRunner: new MockClaudeCodeRunner(undefined, undefined, { recordsCodeReview: false }),
      gitOps,
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      repoLocalPath: '/x',
      checkCommands: NOOP_CHECKS,
    });
    expect(result.outcome).toBe('escalated');
    expect(result.reasons[0]).toMatch(/\/code-review/);
    expect(gitOps.calls.some((c) => c[0] === 'push' || c[0] === 'commitAll')).toBe(false);
    const pending = await new ApprovalsStore(handle.db).listPending();
    expect(pending.map((a) => [a.id, a.action])).toEqual([
      ['pr-missing-review:org/repo#42', 'manual_review_missing_code_review'],
    ]);

    // The next tick doesn't redo the attempt while that's waiting on a person.
    const runner = new MockClaudeCodeRunner();
    const again = await monitorPr({
      db: handle.db,
      repo: 'org/repo',
      number: 42,
      reader: new MockPrStatusReader(makePr({ comments: [makeComment('typo: fix spelling')] })),
      claudeRunner: runner,
      gitOps,
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      repoLocalPath: '/x',
      checkCommands: NOOP_CHECKS,
    });
    expect(again.outcome).toBe('escalated');
    expect(runner.calls).toHaveLength(0);
  });

  it('keeps the review record off the PR branch', async () => {
    handle = await createTestDb();
    const result = await monitorPr({
      db: handle.db,
      repo: 'org/repo',
      number: 42,
      reader: new MockPrStatusReader(makePr({ comments: [makeComment('typo: fix spelling')] })),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps: new MockGitOps(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      repoLocalPath: '/x',
      checkCommands: NOOP_CHECKS,
    });
    expect(result.outcome).toBe('auto_fix_pushed');
    expect(existsSync(join(result.worktreePath!, '.work-agent', 'code-review.json'))).toBe(false);
  });

  it('audit log records the full auto-fix sequence', async () => {
    handle = await createTestDb();
    await monitorPr({
      db: handle.db,
      repo: 'org/repo',
      number: 42,
      reader: new MockPrStatusReader(makePr({ comments: [makeComment('typo: fix spelling')] })),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps: new MockGitOps(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      repoLocalPath: '/x',
      checkCommands: NOOP_CHECKS,
    });
    const events = (await new AuditLog(handle.db).readAll()).map((e) => e.event);
    expect(events).toEqual([
      'pr_monitor_started',
      'pr_monitor_fetched_status',
      'pr_monitor_worktree_created',
      'pr_monitor_implementation_finished',
      'pr_monitor_code_review',
      'pr_monitor_checks_run',
      'pr_monitor_gate_decision',
      'pr_monitor_pushed_followup',
    ]);
  });
});
