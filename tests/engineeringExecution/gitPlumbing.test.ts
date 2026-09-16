import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, rmSync, mkdirSync, lstatSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager, materializeRealNodeModules } from '../../src/agents/engineeringExecution/worktree.js';
import { GitCliOps, MockGitOps } from '../../src/agents/engineeringExecution/gitOps.js';
import { finishExecution } from '../../src/agents/engineeringExecution/runbook.js';
import { PlaywrightScreenshotCapture, type CaptureResult, type ScreenshotStep } from '../../src/agents/engineeringExecution/screenshot.js';
import { MockPullRequestCreator } from '../../src/agents/engineeringExecution/prOps.js';
import { createTestDb, type TestDbHandle } from '../../src/test-utils/db.js';
import type { TaskContext } from '../../src/agents/engineeringExecution/models.js';

function run(cmd: string[], cwd: string) {
  execFileSync(cmd[0]!, cmd.slice(1), { cwd });
}

describe('git plumbing (real git, throwaway scratch repo, never touches any real project)', () => {
  let root: string;
  let bareRemote: string;
  let localRepo: string;
  let worktreesRoot: string;
  let manager: WorktreeManager;
  let dbHandle: TestDbHandle | null = null;

  afterEach(async () => {
    await dbHandle?.close();
    dbHandle = null;
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'work-agent-git-test-'));
    bareRemote = join(root, 'remote.git');
    localRepo = join(root, 'local');
    worktreesRoot = join(root, 'worktrees');

    run(['git', 'init', '--bare', bareRemote], root);
    run(['git', 'clone', bareRemote, localRepo], root);
    run(['git', 'config', 'user.email', 'test@example.com'], localRepo);
    run(['git', 'config', 'user.name', 'Test'], localRepo);
    writeFileSync(join(localRepo, 'README.md'), 'hello\n');
    run(['git', 'add', '-A'], localRepo);
    run(['git', 'commit', '-m', 'initial commit'], localRepo);
    run(['git', 'branch', '-M', 'main'], localRepo);
    run(['git', 'push', '-u', 'origin', 'main'], localRepo);

    manager = new WorktreeManager(localRepo, worktreesRoot);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creating a worktree does not disturb the primary checkout', async () => {
    const before = execFileSync('git', ['branch', '--show-current'], { cwd: localRepo }).toString().trim();
    const path = await manager.create('test-task', 'main');
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(path, 'README.md'))).toBe(true);
    const after = execFileSync('git', ['branch', '--show-current'], { cwd: localRepo }).toString().trim();
    expect(after).toBe(before);
  });

  it('removing a worktree cleans it up', async () => {
    const path = await manager.create('test-task', 'main');
    await manager.remove(path);
    expect(existsSync(path)).toBe(false);
  });

  it('full branch/commit/push round trip lands on the "remote"', async () => {
    const path = await manager.create('feature-task', 'main');
    const ops = new GitCliOps();

    await ops.createBranch(path, 'work-agent/feature-task');
    writeFileSync(join(path, 'new_file.txt'), 'new content\n');
    const committed = await ops.commitAll(path, 'add new_file.txt');
    expect(committed).toBe(true);

    const diff = await ops.diffStat(path, 'origin/main');
    expect(diff).toContain('new_file.txt');

    await ops.push(path, 'work-agent/feature-task');

    const branches = execFileSync('git', ['branch', '-a'], { cwd: bareRemote }).toString();
    expect(branches).toContain('work-agent/feature-task');
  });

  it('a fresh worktree gets node_modules symlinked from the primary checkout, when one already exists there', async () => {
    writeFileSync(join(localRepo, 'package.json'), '{}');
    mkdirSync(join(localRepo, 'node_modules'));
    writeFileSync(join(localRepo, 'node_modules', 'marker.txt'), 'shared-install');

    const path = await manager.create('dep-symlink-task', 'main');

    expect(lstatSync(join(path, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(path, 'node_modules', 'marker.txt'), 'utf-8')).toBe('shared-install');
  });

  it('copies .env from the primary checkout into a fresh worktree, as a real file, not a symlink', async () => {
    writeFileSync(join(localRepo, '.env'), 'DATABASE_URL=postgres://scratch\n');

    const path = await manager.create('env-copy-task', 'main');

    expect(readFileSync(join(path, '.env'), 'utf-8')).toBe('DATABASE_URL=postgres://scratch\n');
    expect(lstatSync(join(path, '.env')).isSymbolicLink()).toBe(false);
  });

  it('materializeRealNodeModules replaces the symlink with a real, working install', async () => {
    writeFileSync(join(localRepo, 'package.json'), JSON.stringify({ name: 'scratch', version: '1.0.0' }));
    run(['git', 'add', '-A'], localRepo);
    run(['git', 'commit', '-m', 'add package.json'], localRepo);
    run(['git', 'push', 'origin', 'main'], localRepo);
    mkdirSync(join(localRepo, 'node_modules'));
    writeFileSync(join(localRepo, 'node_modules', 'marker.txt'), 'shared-install');

    const path = await manager.create('materialize-task', 'main');
    expect(lstatSync(join(path, 'node_modules')).isSymbolicLink()).toBe(true);

    await materializeRealNodeModules(path);

    // A zero-dependency package.json gets no node_modules dir at all from
    // npm — the meaningful checks are that install actually ran (the
    // lockfile it writes) and that the old symlink is gone, so the shared
    // marker from its target is no longer reachable from this worktree.
    expect(existsSync(join(path, 'package-lock.json'))).toBe(true);
    expect(existsSync(join(path, 'node_modules', 'marker.txt'))).toBe(false);
  }, 30_000);

  it('falls back to a real install in the worktree when the primary checkout has never been installed', async () => {
    // Committed and pushed — the worktree is checked out from origin/main,
    // so an uncommitted package.json in localRepo alone wouldn't appear
    // there at all, real install or not.
    writeFileSync(join(localRepo, 'package.json'), JSON.stringify({ name: 'scratch', version: '1.0.0' }));
    run(['git', 'add', '-A'], localRepo);
    run(['git', 'commit', '-m', 'add package.json'], localRepo);
    run(['git', 'push', 'origin', 'main'], localRepo);
    // Deliberately no node_modules and no lockfile in localRepo.

    const path = await manager.create('dep-install-task', 'main');

    // A zero-dependency package.json doesn't get an actual node_modules dir
    // from npm — the meaningful assertion is that install actually ran
    // (proven by the lockfile it writes) rather than the symlink path.
    expect(existsSync(join(path, 'package-lock.json'))).toBe(true);
    expect(existsSync(join(path, 'node_modules'))).toBe(false);
  }, 30_000);

  it('commitAll returns false when nothing changed', async () => {
    const path = await manager.create('no-op-task', 'main');
    const ops = new GitCliOps();
    await ops.createBranch(path, 'work-agent/no-op-task');
    expect(await ops.commitAll(path, 'nothing changed')).toBe(false);
  });

  it('publishAssetBranch lands files on their own branch without disturbing the checked-out branch or its commit history', async () => {
    const path = await manager.create('screenshot-task', 'main');
    const ops = new GitCliOps();
    await ops.createBranch(path, 'work-agent/screenshot-task');

    const shotPath = join(path, 'shot.png');
    writeFileSync(shotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const branchBefore = execFileSync('git', ['branch', '--show-current'], { cwd: path }).toString().trim();

    await ops.publishAssetBranch(path, 'work-agent/screenshots/screenshot-task', [{ path: shotPath, name: 'shot.png' }]);

    // Still on the code branch, working tree untouched — the asset commit
    // never checked anything out or modified the index here.
    const branchAfter = execFileSync('git', ['branch', '--show-current'], { cwd: path }).toString().trim();
    expect(branchAfter).toBe(branchBefore);
    expect(await ops.commitAll(path, 'should be a no-op, shot.png is untracked but unrelated to this check')).toBe(true);
    // The code branch's own log has nothing to do with the asset commit.
    const log = execFileSync('git', ['log', '--oneline'], { cwd: path }).toString();
    expect(log).not.toContain('Screenshots for');

    // The asset branch landed on the remote as its own orphan history.
    const branches = execFileSync('git', ['branch', '-a'], { cwd: bareRemote }).toString();
    expect(branches).toContain('work-agent/screenshots/screenshot-task');
    const assetLog = execFileSync('git', ['log', '--oneline', 'work-agent/screenshots/screenshot-task'], { cwd: bareRemote })
      .toString();
    expect(assetLog).toContain('Screenshots for work-agent/screenshots/screenshot-task');
    const assetFiles = execFileSync('git', ['ls-tree', '--name-only', 'work-agent/screenshots/screenshot-task'], { cwd: bareRemote })
      .toString();
    expect(assetFiles).toContain('shot.png');
  });

  it('materializes real node_modules before the real screenshot capture runs, even when the caller passes an explicit PlaywrightScreenshotCapture instance', async () => {
    // Regression test: cli.ts's exec-finish always passes `new
    // PlaywrightScreenshotCapture()` explicitly — it is never the `??`
    // default fallback. A guard that only materializes when the caller
    // left screenshotCapture undefined never fires for that real call
    // path at all, silently leaving the fast (Turbopack-incompatible)
    // symlink in place for every real run.
    writeFileSync(join(localRepo, 'package.json'), JSON.stringify({ name: 'scratch', version: '1.0.0' }));
    run(['git', 'add', '-A'], localRepo);
    run(['git', 'commit', '-m', 'add package.json'], localRepo);
    run(['git', 'push', 'origin', 'main'], localRepo);
    mkdirSync(join(localRepo, 'node_modules'));
    writeFileSync(join(localRepo, 'node_modules', 'marker.txt'), 'shared-install');

    const worktreePath = await manager.create('screenshot-materialize-task', 'main');
    expect(lstatSync(join(worktreePath, 'node_modules')).isSymbolicLink()).toBe(true);

    mkdirSync(join(worktreePath, '.work-agent'));
    const steps: ScreenshotStep[] = [{ label: 'home', path: '/' }];
    writeFileSync(join(worktreePath, '.work-agent', 'screenshot-steps.json'), JSON.stringify(steps));

    let sawSymlinkInsideCapture: boolean | null = null;
    class FakePlaywrightCapture extends PlaywrightScreenshotCapture {
      override async capture(wtPath: string): Promise<CaptureResult> {
        // A zero-dependency package.json (this test's fixture) gets no
        // node_modules dir at all from a real `npm install` — absent is
        // just as much "not the shared symlink anymore" as a real one.
        try {
          sawSymlinkInsideCapture = lstatSync(join(wtPath, 'node_modules')).isSymbolicLink();
        } catch {
          sawSymlinkInsideCapture = false;
        }
        return { screenshots: [], gifPath: undefined };
      }
    }

    dbHandle = await createTestDb();
    const task: TaskContext = {
      key: 'PROJ-1',
      project: 'PROJ',
      summary: 'Fix a thing',
      description: 'd'.repeat(200),
      issueType: 'Task',
      status: 'To Do',
      priority: 'Medium',
      url: 'http://x/PROJ-1',
      comments: [],
    };
    await finishExecution({
      db: dbHandle.db,
      config: {
        jira: { myProjects: [], ignoredKeys: [] },
        github: {
          approvedRepos: ['org/repo'],
          repoMap: { PROJ: 'org/repo' },
          repoLocalPaths: { 'org/repo': localRepo },
          repoDefaultBranches: {},
          previewRecipes: {
            'org/repo': { startCommand: ['node', '-e', ''], port: 4321, readyPath: '/', readyTimeoutMs: 5000, env: {} },
          },
        },
        slack: { relevantChannels: [] },
        engineeringExecution: { openPrAsDraft: true },
        communication: { autoSendRoutine: false },
      },
      task,
      repo: { projectKey: 'PROJ', owner: 'org', repo: 'repo', localPath: localRepo, defaultBranch: 'main' },
      worktreePath,
      startedAt: new Date(),
      outcome: { success: true, summary: 'did the thing' },
      gitOps: new MockGitOps(),
      prCreator: new MockPullRequestCreator(),
      checkCommands: [['noop', ['true']]],
      screenshotCapture: new FakePlaywrightCapture(),
    });

    expect(sawSymlinkInsideCapture).toBe(false);
  }, 30_000);
});
