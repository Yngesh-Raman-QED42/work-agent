import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RepoInfo } from './models.js';
import type { TaskContext } from './models.js';

// Written by `exec-start`, read by `exec-finish` — lets the two halves of
// Engineering Execution run as separate CLI invocations around the one
// step that genuinely needs a live agent (see runbook.ts), without a
// database schema change: everything `exec-finish` needs travels with the
// worktree itself, the same way screenshot-steps.json does.
export const EXECUTION_STATE_PATH = '.work-agent/execution-state.json';

export interface ExecutionState {
  task: TaskContext;
  repo: RepoInfo;
  worktreePath: string;
  startedAt: string; // ISO
  prompt: string;
}

export async function writeExecutionState(state: ExecutionState): Promise<void> {
  const fullPath = path.join(state.worktreePath, EXECUTION_STATE_PATH);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(state, null, 2));
}

export async function readExecutionState(worktreePath: string): Promise<ExecutionState | null> {
  const fullPath = path.join(worktreePath, EXECUTION_STATE_PATH);
  if (!existsSync(fullPath)) return null;
  try {
    return JSON.parse(await readFile(fullPath, 'utf-8')) as ExecutionState;
  } catch {
    return null;
  }
}
