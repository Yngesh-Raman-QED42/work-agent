import { runOrThrow } from './shell.js';

/** No method here ever touches `main`/the default branch, force-pushes, or
 * merges anything. Branch/commit/push only, on the caller-supplied isolated
 * branch name, inside the caller-supplied worktree. */
export interface GitOps {
  createBranch(worktreePath: string, branchName: string): Promise<void>;
  /** Returns false if there was nothing to commit. */
  commitAll(worktreePath: string, message: string): Promise<boolean>;
  push(worktreePath: string, branchName: string): Promise<void>;
  diffStat(worktreePath: string, baseRef: string): Promise<string>;
}

export class GitCliOps implements GitOps {
  async createBranch(worktreePath: string, branchName: string): Promise<void> {
    await runOrThrow(['git', 'checkout', '-b', branchName], { cwd: worktreePath });
  }

  async commitAll(worktreePath: string, message: string): Promise<boolean> {
    await runOrThrow(['git', 'add', '-A'], { cwd: worktreePath });
    const status = await runOrThrow(['git', 'status', '--porcelain'], { cwd: worktreePath });
    if (!status.output.trim()) return false;
    await runOrThrow(['git', 'commit', '-m', message], { cwd: worktreePath });
    return true;
  }

  async push(worktreePath: string, branchName: string): Promise<void> {
    await runOrThrow(['git', 'push', '-u', 'origin', branchName], { cwd: worktreePath, timeoutMs: 180_000 });
  }

  async diffStat(worktreePath: string, baseRef: string): Promise<string> {
    const result = await runOrThrow(['git', 'diff', '--stat', baseRef], { cwd: worktreePath });
    return result.output;
  }
}

export class MockGitOps implements GitOps {
  calls: Array<[string, ...unknown[]]> = [];
  hasChanges = true;

  constructor(private fakeDiffStat = ' src/example.ts | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)') {}

  async createBranch(worktreePath: string, branchName: string): Promise<void> {
    this.calls.push(['createBranch', worktreePath, branchName]);
  }

  async commitAll(worktreePath: string, message: string): Promise<boolean> {
    this.calls.push(['commitAll', worktreePath, message]);
    return this.hasChanges;
  }

  async push(worktreePath: string, branchName: string): Promise<void> {
    this.calls.push(['push', worktreePath, branchName]);
  }

  async diffStat(worktreePath: string, baseRef: string): Promise<string> {
    this.calls.push(['diffStat', worktreePath, baseRef]);
    return this.fakeDiffStat;
  }
}
