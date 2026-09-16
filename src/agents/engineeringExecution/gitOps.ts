import { runOrThrow } from './shell.js';

export interface AssetFile {
  /** Absolute (or worktree-cwd-relative) path to the file on disk. */
  path: string;
  /** Flat filename the asset is stored/served under — no directories. */
  name: string;
}

/** No method here ever touches `main`/the default branch, force-pushes, or
 * merges anything. Branch/commit/push only, on the caller-supplied isolated
 * branch name, inside the caller-supplied worktree. */
export interface GitOps {
  createBranch(worktreePath: string, branchName: string): Promise<void>;
  /** Returns false if there was nothing to commit. */
  commitAll(worktreePath: string, message: string): Promise<boolean>;
  push(worktreePath: string, branchName: string): Promise<void>;
  diffStat(worktreePath: string, baseRef: string): Promise<string>;
  /**
   * Publishes files as a standalone orphan branch — via git plumbing
   * directly against the object database, so it never touches the working
   * tree or index of whatever branch is currently checked out in
   * `worktreePath`. Used to host PR screenshots/GIFs so they're linkable
   * (via raw.githubusercontent.com) without ever being part of the code
   * PR's own diff or commit history.
   */
  publishAssetBranch(worktreePath: string, branchName: string, files: AssetFile[]): Promise<void>;
  /** Every untracked path (files and whole new directories alike) in the
   * worktree right now — used to detect files a dev server run created as
   * a runtime side effect (e.g. an on-disk avatar image cache) that were
   * never part of the implementer's actual change, so they can be removed
   * before the eventual commit instead of silently riding along in it. */
  listUntrackedFiles(worktreePath: string): Promise<string[]>;
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

  async publishAssetBranch(worktreePath: string, branchName: string, files: AssetFile[]): Promise<void> {
    if (files.length === 0) return;
    const entries: string[] = [];
    for (const file of files) {
      const hashed = await runOrThrow(['git', 'hash-object', '-w', file.path], { cwd: worktreePath });
      entries.push(`100644 blob ${hashed.output.trim()}\t${file.name}`);
    }
    const tree = await runOrThrow(['git', 'mktree'], { cwd: worktreePath, input: entries.join('\n') + '\n' });
    const commit = await runOrThrow(
      ['git', 'commit-tree', tree.output.trim(), '-m', `Screenshots for ${branchName}`],
      { cwd: worktreePath },
    );
    await runOrThrow(['git', 'push', 'origin', `${commit.output.trim()}:refs/heads/${branchName}`], {
      cwd: worktreePath,
      timeoutMs: 180_000,
    });
  }

  async listUntrackedFiles(worktreePath: string): Promise<string[]> {
    const result = await runOrThrow(['git', 'status', '--porcelain', '--untracked-files=all'], { cwd: worktreePath });
    return result.output
      .split('\n')
      .filter((line) => line.startsWith('?? '))
      .map((line) => line.slice(3).trim())
      .map((p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p))
      .filter(Boolean);
  }
}

export class MockGitOps implements GitOps {
  calls: Array<[string, ...unknown[]]> = [];
  hasChanges = true;
  // One entry consumed per listUntrackedFiles() call, in order (the last
  // entry repeats once exhausted) — lets a test simulate "before" and
  // "after" snapshots differing, e.g. a dev server run leaving a new file.
  fakeUntrackedFilesSequence: string[][] = [[]];
  private untrackedCallIndex = 0;

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

  async publishAssetBranch(worktreePath: string, branchName: string, files: AssetFile[]): Promise<void> {
    this.calls.push(['publishAssetBranch', worktreePath, branchName, files]);
  }

  async listUntrackedFiles(worktreePath: string): Promise<string[]> {
    this.calls.push(['listUntrackedFiles', worktreePath]);
    const idx = Math.min(this.untrackedCallIndex, this.fakeUntrackedFilesSequence.length - 1);
    this.untrackedCallIndex += 1;
    return this.fakeUntrackedFilesSequence[idx]!;
  }
}
