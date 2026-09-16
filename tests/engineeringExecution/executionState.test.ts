import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeExecutionState, readExecutionState, EXECUTION_STATE_PATH } from '../../src/agents/engineeringExecution/executionState.js';
import type { TaskContext } from '../../src/integrations/jira/detail.js';
import type { RepoInfo } from '../../src/agents/engineeringExecution/models.js';

const cleanupPaths: string[] = [];
afterEach(() => {
  for (const p of cleanupPaths.splice(0)) rmSync(p, { recursive: true, force: true });
});

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'exec-state-test-'));
  cleanupPaths.push(dir);
  return dir;
}

const task: TaskContext = {
  key: 'PROJ-1',
  project: 'PROJ',
  summary: 'Fix a thing',
  description: 'd'.repeat(100),
  issueType: 'Task',
  status: 'To Do',
  priority: 'Medium',
  url: 'http://x/PROJ-1',
  comments: [],
};

const repo: RepoInfo = { projectKey: 'PROJ', owner: 'org', repo: 'repo', localPath: '/x', defaultBranch: 'main' };

describe('execution state (exec-start / exec-finish handoff)', () => {
  it('round-trips exactly what exec-finish needs, with nothing lost', async () => {
    const worktreePath = makeWorktree();
    const startedAt = new Date('2026-09-01T00:00:00Z').toISOString();
    await writeExecutionState({ task, repo, worktreePath, startedAt, prompt: 'implement it' });

    const state = await readExecutionState(worktreePath);
    expect(state).toEqual({ task, repo, worktreePath, startedAt, prompt: 'implement it' });
  });

  it('returns null when exec-start was never run for this worktree', async () => {
    const worktreePath = makeWorktree();
    expect(await readExecutionState(worktreePath)).toBeNull();
  });

  it('returns null on a corrupted state file rather than throwing', async () => {
    const worktreePath = makeWorktree();
    await writeExecutionState({ task, repo, worktreePath, startedAt: new Date().toISOString(), prompt: 'x' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(worktreePath, EXECUTION_STATE_PATH), '{ not valid json');
    expect(await readExecutionState(worktreePath)).toBeNull();
  });
});
