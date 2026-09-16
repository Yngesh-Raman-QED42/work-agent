import { mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runOrThrow, run } from './shell.js';

/** Creates/removes an isolated `git worktree` off a repo's default branch.
 * Never touches the caller's primary checkout — that's the entire point. */
export class WorktreeManager {
  constructor(
    private repoLocalPath: string,
    private worktreesRoot: string = join(tmpdir(), 'work-agent-worktrees'),
  ) {}

  async create(nameHint: string, defaultBranch = 'main'): Promise<string> {
    if (!existsSync(this.worktreesRoot)) mkdirSync(this.worktreesRoot, { recursive: true });
    const path = mkdtempSync(join(this.worktreesRoot, `${nameHint}-`));

    await runOrThrow(['git', 'fetch', 'origin', defaultBranch], { cwd: this.repoLocalPath, timeoutMs: 120_000 });
    await runOrThrow(['git', 'worktree', 'add', '--detach', path, `origin/${defaultBranch}`], {
      cwd: this.repoLocalPath,
      timeoutMs: 120_000,
    });
    return path;
  }

  /** Checks out an EXISTING remote branch (e.g. a PR branch) directly,
   * rather than a fresh detached HEAD off the default branch — used by PR
   * Monitoring to push follow-up commits onto an already-open PR. */
  async createForBranch(nameHint: string, branchName: string): Promise<string> {
    if (!existsSync(this.worktreesRoot)) mkdirSync(this.worktreesRoot, { recursive: true });
    const path = mkdtempSync(join(this.worktreesRoot, `${nameHint}-`));

    await runOrThrow(['git', 'fetch', 'origin', branchName], { cwd: this.repoLocalPath, timeoutMs: 120_000 });
    await runOrThrow(['git', 'worktree', 'add', path, `origin/${branchName}`, '-B', branchName], {
      cwd: this.repoLocalPath,
      timeoutMs: 120_000,
    });
    return path;
  }

  async remove(path: string): Promise<void> {
    await run(['git', 'worktree', 'remove', '--force', path], { cwd: this.repoLocalPath, timeoutMs: 60_000 });
  }
}
