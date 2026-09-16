import { mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
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
    await this.ensureDependencies(path);
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
    await this.ensureDependencies(path);
    return path;
  }

  /**
   * `git worktree add` gives a fresh checkout with no `node_modules` —
   * it's gitignored, so nothing about the worktree itself provides it. Left
   * unhandled, every check (test/lint/typecheck/build) fails immediately in
   * every worktree, regardless of what the ticket's own change touches.
   *
   * Fastest, and safe: symlink the primary checkout's own `node_modules`.
   * Safe specifically because CLAUDE.md forbids the implementer from ever
   * touching lockfiles autonomously, so package.json/package-lock.json are
   * guaranteed identical between the worktree and the primary checkout —
   * there is no dependency change a symlink could paper over. Only when the
   * primary checkout has never been installed at all does this fall back to
   * a real (slower) install inside the worktree itself.
   */
  private async ensureDependencies(worktreePath: string): Promise<void> {
    const sharedModules = join(this.repoLocalPath, 'node_modules');
    if (!existsSync(join(this.repoLocalPath, 'package.json'))) return; // not a Node project — nothing to do
    if (existsSync(sharedModules)) {
      await symlink(sharedModules, join(worktreePath, 'node_modules'), 'dir');
      return;
    }
    const hasLockfile = existsSync(join(this.repoLocalPath, 'package-lock.json'));
    await runOrThrow(hasLockfile ? ['npm', 'ci'] : ['npm', 'install'], { cwd: worktreePath, timeoutMs: 600_000 });
  }

  async remove(path: string): Promise<void> {
    await run(['git', 'worktree', 'remove', '--force', path], { cwd: this.repoLocalPath, timeoutMs: 60_000 });
  }
}
