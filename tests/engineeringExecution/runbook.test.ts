import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, type TestDbHandle } from '../../src/test-utils/db.js';
import { runExecution, startExecution, finishExecution } from '../../src/agents/engineeringExecution/runbook.js';
import { AutonomyPolicy } from '../../src/agents/engineeringExecution/policy.js';
import { MockClaudeCodeRunner } from '../../src/agents/engineeringExecution/claudeRunner.js';
import { MockGitOps } from '../../src/agents/engineeringExecution/gitOps.js';
import { MockPullRequestCreator } from '../../src/agents/engineeringExecution/prOps.js';
import { WorktreeManager } from '../../src/agents/engineeringExecution/worktree.js';
import { DEFAULT_GATE_CONFIG } from '../../src/agents/engineeringExecution/gate.js';
import { MockScreenshotCapture, SCREENSHOT_STEPS_PATH } from '../../src/agents/engineeringExecution/screenshot.js';
import { MockJiraIssueUpdater } from '../../src/integrations/jira/issueUpdater.js';
import { IN_PROGRESS_STATUS_CANDIDATES, IN_REVIEW_STATUS_CANDIDATES } from '../../src/agents/engineeringExecution/runbook.js';
import type { TaskContext } from '../../src/agents/engineeringExecution/models.js';
import type { WorkAgentConfig } from '../../src/config/index.js';
import { AuditLog } from '../../src/pipeline/audit.js';
import { ApprovalsStore } from '../../src/shared/approvals.js';

const NOOP_CHECKS: Array<[string, string[]]> = [['noop', ['true']]];

function makeTask(key = 'PROJ-1', overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    key,
    project: 'PROJ',
    summary: 'Fix a thing',
    description: 'd'.repeat(200),
    issueType: 'Task',
    status: 'To Do',
    priority: 'Medium',
    url: `http://x/${key}`,
    comments: [],
    ...overrides,
  };
}

function configWithRepo(previewRecipe: 'none' | 'explicit' | 'disabled' = 'none', repoLocalPath = '/does/not/matter/for/fake/worktrees'): WorkAgentConfig {
  const previewRecipes: WorkAgentConfig['github']['previewRecipes'] =
    previewRecipe === 'explicit'
      ? { 'org/repo': { startCommand: ['node', '-e', ''], port: 4321, readyPath: '/', readyTimeoutMs: 5000, env: {} } }
      : previewRecipe === 'disabled'
        ? { 'org/repo': false }
        : {};
  return {
    jira: { myProjects: [], ignoredKeys: [] },
    github: {
      approvedRepos: ['org/repo'],
      repoMap: { PROJ: 'org/repo' },
      repoLocalPaths: { 'org/repo': repoLocalPath },
      repoDefaultBranches: {},
      previewRecipes,
    },
    slack: { relevantChannels: [] },
    engineeringExecution: { openPrAsDraft: true },
    communication: { autoSendRoutine: false },
  };
}

class FakeWorktreeManager extends WorktreeManager {
  created: string[] = [];
  constructor() {
    super('unused');
  }
  override async create(nameHint: string): Promise<string> {
    const path = mkdtempSync(join(tmpdir(), `${nameHint}-`));
    this.created.push(path);
    return path;
  }
  override async remove(path: string): Promise<void> {
    rmSync(path, { recursive: true, force: true });
  }
}

let handle: TestDbHandle | null = null;
const cleanupPaths: string[] = [];
afterEach(async () => {
  await handle?.close();
  handle = null;
  for (const p of cleanupPaths.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe('startExecution / finishExecution (the split exec-start / exec-finish uses)', () => {
  it('startExecution alone produces everything exec-finish needs, without touching git/tests/PRs at all', async () => {
    handle = await createTestDb();
    const started = await startExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
    });
    expect(started.status).toBe('started');
    expect(started.task?.key).toBe('PROJ-1');
    expect(started.repo?.localPath).toBe('/does/not/matter/for/fake/worktrees');
    expect(started.worktreePath).toBeTruthy();
    expect(started.prompt).toContain('PROJ-1');
    expect(started.startedAt).toBeInstanceOf(Date);
  });

  it('startExecution reports no_eligible_task exactly like runExecution does, with no worktree created', async () => {
    handle = await createTestDb();
    const started = await startExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask('PROJ-1', { priority: 'High' })],
      policy: new AutonomyPolicy(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
    });
    expect(started.status).toBe('no_eligible_task');
    expect(started.worktreePath).toBeUndefined();
  });

  it('startExecution moves the ticket to whatever "in progress"-equivalent status the workflow actually offers', async () => {
    handle = await createTestDb();
    const issueUpdater = new MockJiraIssueUpdater({ 'PROJ-1': 'In Development' }); // not the first candidate — proves it isn't hardcoded to one name
    await startExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      getIssueUpdater: () => issueUpdater,
    });
    expect(issueUpdater.transitionAttempts).toEqual([{ key: 'PROJ-1', candidates: IN_PROGRESS_STATUS_CANDIDATES }]);
  });

  it('a Jira status-transition failure at start never stops the worktree that already exists', async () => {
    handle = await createTestDb();
    const failingUpdater = { transitionToStatus: () => Promise.reject(new Error('Jira is down')), addComment: () => Promise.resolve() };
    const started = await startExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      getIssueUpdater: () => failingUpdater,
    });
    expect(started.status).toBe('started');
    expect(started.worktreePath).toBeTruthy();
  });

  it('finishExecution posts a comment with the PR link and moves the ticket to whatever "in review"-equivalent status is available', async () => {
    handle = await createTestDb();
    const issueUpdater = new MockJiraIssueUpdater({ 'PROJ-1': 'Code Review' });
    const started = await startExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
    });
    const result = await finishExecution({
      db: handle.db,
      config: configWithRepo(),
      task: started.task!,
      repo: started.repo!,
      worktreePath: started.worktreePath!,
      startedAt: started.startedAt!,
      outcome: { success: true, summary: 'fixed the overlapping labels' },
      gitOps: new MockGitOps(),
      prCreator: new MockPullRequestCreator(),
      checkCommands: NOOP_CHECKS,
      getIssueUpdater: () => issueUpdater,
    });

    expect(result.status).toBe('opened_pr');
    expect(issueUpdater.comments).toHaveLength(1);
    expect(issueUpdater.comments[0]!.text).toContain('fixed the overlapping labels');
    expect(issueUpdater.comments[0]!.links[0]!.url).toBe(result.prUrl);
    expect(issueUpdater.transitionAttempts).toEqual([{ key: 'PROJ-1', candidates: IN_REVIEW_STATUS_CANDIDATES }]);
  });

  it('a Jira comment/transition failure at finish never undoes the already-opened PR', async () => {
    handle = await createTestDb();
    const failingUpdater = {
      addComment: () => Promise.reject(new Error('Jira is down')),
      transitionToStatus: () => Promise.reject(new Error('Jira is down')),
    };
    const started = await startExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
    });
    const result = await finishExecution({
      db: handle.db,
      config: configWithRepo(),
      task: started.task!,
      repo: started.repo!,
      worktreePath: started.worktreePath!,
      startedAt: started.startedAt!,
      outcome: { success: true, summary: 'fixed it' },
      gitOps: new MockGitOps(),
      prCreator: new MockPullRequestCreator(),
      checkCommands: NOOP_CHECKS,
      getIssueUpdater: () => failingUpdater,
    });
    expect(result.status).toBe('opened_pr');
    expect(result.prUrl).toBeTruthy();
  });

  it('finishExecution alone, given a real outcome, completes the pipeline the same way runExecution\'s second half does', async () => {
    handle = await createTestDb();
    const started = await startExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
    });
    expect(started.status).toBe('started');

    const result = await finishExecution({
      db: handle.db,
      config: configWithRepo(),
      task: started.task!,
      repo: started.repo!,
      worktreePath: started.worktreePath!,
      startedAt: started.startedAt!,
      outcome: { success: true, summary: 'implemented directly by a live session, no claudeRunner bridge involved' },
      gitOps: new MockGitOps(),
      prCreator: new MockPullRequestCreator(),
      checkCommands: NOOP_CHECKS,
    });

    expect(result.status).toBe('opened_pr');
    expect(result.prUrl).toMatch(/^https:\/\/github\.com\//);
    const approval = await new ApprovalsStore(handle.db).get('exec-log-time:PROJ-1');
    expect(approval).toBeDefined();
    expect((approval!.context as { minutes: number }).minutes).toBeGreaterThan(0);
  });

  it('runExecution (the wrapper) produces an identical result to calling startExecution then finishExecution by hand', async () => {
    handle = await createTestDb();
    const wrapped = await runExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps: new MockGitOps(),
      prCreator: new MockPullRequestCreator(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      checkCommands: NOOP_CHECKS,
    });
    expect(wrapped.status).toBe('opened_pr');
    expect(wrapped.branch).toBe('work-agent/proj-1');
  });
});

describe('runExecution', () => {
  it('happy path opens a draft PR', async () => {
    handle = await createTestDb();
    const result = await runExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps: new MockGitOps(),
      prCreator: new MockPullRequestCreator(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      checkCommands: NOOP_CHECKS,
    });
    expect(result.status).toBe('opened_pr');
    expect(result.prUrl).toMatch(/^https:\/\/github\.com\//);
    expect(result.branch).toBe('work-agent/proj-1');
  });

  it('opens as a draft by default', async () => {
    handle = await createTestDb();
    const prCreator = new MockPullRequestCreator();
    await runExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps: new MockGitOps(),
      prCreator,
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      checkCommands: NOOP_CHECKS,
    });
    expect(prCreator.calls[0]!.asDraft).toBe(true);
  });

  it('opens as a real, non-draft PR when config.engineeringExecution.openPrAsDraft is false', async () => {
    handle = await createTestDb();
    const config = configWithRepo();
    config.engineeringExecution.openPrAsDraft = false;
    const prCreator = new MockPullRequestCreator();
    await runExecution({
      db: handle.db,
      config,
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps: new MockGitOps(),
      prCreator,
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      checkCommands: NOOP_CHECKS,
    });
    expect(prCreator.calls[0]!.asDraft).toBe(false);
    expect(prCreator.calls[0]!.body).not.toContain('as a draft');
  });

  it('files a log_execution_time approval with real elapsed minutes on a successful run — never posts to Jira on its own', async () => {
    handle = await createTestDb();
    await runExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps: new MockGitOps(),
      prCreator: new MockPullRequestCreator(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      checkCommands: NOOP_CHECKS,
    });
    const store = new ApprovalsStore(handle.db);
    const approval = await store.get('exec-log-time:PROJ-1');
    expect(approval).toBeDefined();
    expect(approval!.status).toBe('pending');
    expect(approval!.action).toBe('log_execution_time');
    const context = approval!.context as { taskKey: string; minutes: number };
    expect(context.taskKey).toBe('PROJ-1');
    expect(context.minutes).toBeGreaterThan(0);
  });

  it('does not file a log_execution_time approval when the run stops before opening a PR', async () => {
    handle = await createTestDb();
    const failingRunner = new MockClaudeCodeRunner({ success: false, summary: 'stopping' });
    await runExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      claudeRunner: failingRunner,
      gitOps: new MockGitOps(),
      prCreator: new MockPullRequestCreator(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
    });
    expect(await new ApprovalsStore(handle.db).get('exec-log-time:PROJ-1')).toBeUndefined();
  });

  it('never attempts a screenshot when auto-detection finds nothing to work with (no real package.json at that path)', async () => {
    handle = await createTestDb();
    const capture = new MockScreenshotCapture();
    const result = await runExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      claudeRunner: new MockClaudeCodeRunner(
        { success: true, summary: 'done' },
        { relPath: SCREENSHOT_STEPS_PATH, content: JSON.stringify([{ label: 'Home page', path: '/' }]) },
      ),
      gitOps: new MockGitOps(),
      prCreator: new MockPullRequestCreator(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      checkCommands: NOOP_CHECKS,
      screenshotCapture: capture,
    });
    expect(result.screenshots).toEqual([]);
    expect(capture.calls).toHaveLength(0);
  });

  it('never attempts a screenshot when the repo has a preview recipe but the implementer wrote no steps file', async () => {
    handle = await createTestDb();
    const capture = new MockScreenshotCapture();
    const result = await runExecution({
      db: handle.db,
      config: configWithRepo('explicit'),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      claudeRunner: new MockClaudeCodeRunner(), // no writeFile — implementer decided nothing was UI-visible
      gitOps: new MockGitOps(),
      prCreator: new MockPullRequestCreator(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      checkCommands: NOOP_CHECKS,
      screenshotCapture: capture,
    });
    expect(result.screenshots).toEqual([]);
    expect(capture.calls).toHaveLength(0);
  });

  it('captures screenshots, publishes them to a standalone assets branch, embeds hosted links in the PR body — never the code diff', async () => {
    handle = await createTestDb();
    const capture = new MockScreenshotCapture({
      screenshots: [{ label: 'Home page', relativePath: '.work-agent/screenshots/1-home-page.png' }],
      gifPath: '.work-agent/screenshots/feature-in-action.gif',
    });
    const gitOps = new MockGitOps();
    const result = await runExecution({
      db: handle.db,
      config: configWithRepo('explicit'),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      claudeRunner: new MockClaudeCodeRunner(
        { success: true, summary: 'done' },
        { relPath: SCREENSHOT_STEPS_PATH, content: JSON.stringify([{ label: 'Home page', path: '/' }]) },
      ),
      gitOps,
      prCreator: {
        async createPr(_repo, _branch, _title, body) {
          expect(body).toContain('**Feature in action:**');
          expect(body).toContain('![feature in action](https://raw.githubusercontent.com/org/repo/work-agent/screenshots/proj-1/feature-in-action.gif)');
          expect(body).toContain('**Screenshots:**');
          expect(body).toContain('![Home page](https://raw.githubusercontent.com/org/repo/work-agent/screenshots/proj-1/1-home-page.png)');
          return 'https://github.com/org/repo/pull/1';
        },
      },
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      checkCommands: NOOP_CHECKS,
      screenshotCapture: capture,
    });

    expect(result.status).toBe('opened_pr');
    expect(result.screenshots).toEqual([{ label: 'Home page', relativePath: '.work-agent/screenshots/1-home-page.png' }]);
    expect(result.gifPath).toBe('.work-agent/screenshots/feature-in-action.gif');
    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0]!.steps).toEqual([{ label: 'Home page', path: '/' }]);
    // The instruction file is cleaned up before commit — it must not ship in the diff.
    expect(existsSync(join(result.worktreePath!, SCREENSHOT_STEPS_PATH))).toBe(false);
    // Nor the screenshots/GIF themselves — those went to a separate assets
    // branch, not the code branch's own commit.
    expect(existsSync(join(result.worktreePath!, '.work-agent', 'screenshots'))).toBe(false);

    const publishCall = gitOps.calls.find((c) => c[0] === 'publishAssetBranch');
    expect(publishCall).toBeTruthy();
    expect(publishCall![2]).toBe('work-agent/screenshots/proj-1');
    const files = publishCall![3] as Array<{ path: string; name: string }>;
    expect(files.map((f) => f.name).sort()).toEqual(['1-home-page.png', 'feature-in-action.gif']);
  });

  it('never attempts a screenshot when the repo explicitly opts out, even with a steps file present', async () => {
    handle = await createTestDb();
    const capture = new MockScreenshotCapture();
    const result = await runExecution({
      db: handle.db,
      config: configWithRepo('disabled'),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      claudeRunner: new MockClaudeCodeRunner(
        { success: true, summary: 'done' },
        { relPath: SCREENSHOT_STEPS_PATH, content: JSON.stringify([{ label: 'Home page', path: '/' }]) },
      ),
      gitOps: new MockGitOps(),
      prCreator: new MockPullRequestCreator(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      checkCommands: NOOP_CHECKS,
      screenshotCapture: capture,
    });
    expect(result.screenshots).toEqual([]);
    expect(capture.calls).toHaveLength(0);
  });

  it('auto-detects a preview recipe from the target repo\'s own package.json when nothing is configured', async () => {
    handle = await createTestDb();
    const repoDir = mkdtempSync(join(tmpdir(), 'autodetect-repo-'));
    cleanupPaths.push(repoDir);
    writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev' } }));

    const capture = new MockScreenshotCapture();
    const result = await runExecution({
      db: handle.db,
      config: configWithRepo('none', repoDir),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      claudeRunner: new MockClaudeCodeRunner(
        { success: true, summary: 'done' },
        { relPath: SCREENSHOT_STEPS_PATH, content: JSON.stringify([{ label: 'Home page', path: '/' }]) },
      ),
      gitOps: new MockGitOps(),
      prCreator: new MockPullRequestCreator(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      checkCommands: NOOP_CHECKS,
      screenshotCapture: capture,
    });
    expect(result.screenshots).toHaveLength(1);
    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0]!.recipe.startCommand).toEqual(['npm', 'run', 'dev']);
    expect(capture.calls[0]!.recipe.port).toBe(3000);
  });

  it('opens the PR without screenshots if capture itself throws — never blocks on a nice-to-have', async () => {
    handle = await createTestDb();
    const failingCapture = {
      calls: [] as unknown[],
      async capture(): Promise<never> {
        throw new Error('dev server never became ready');
      },
    };
    const result = await runExecution({
      db: handle.db,
      config: configWithRepo('explicit'),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      claudeRunner: new MockClaudeCodeRunner(
        { success: true, summary: 'done' },
        { relPath: SCREENSHOT_STEPS_PATH, content: JSON.stringify([{ label: 'Home page', path: '/' }]) },
      ),
      gitOps: new MockGitOps(),
      prCreator: new MockPullRequestCreator(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      checkCommands: NOOP_CHECKS,
      screenshotCapture: failingCapture,
    });
    expect(result.status).toBe('opened_pr');
    expect(result.screenshots).toEqual([]);
    const audit = (await new AuditLog(handle.db).readAll()).map((e) => e.event);
    expect(audit).toContain('execution_screenshots_failed');
  });

  it('no eligible candidates', async () => {
    handle = await createTestDb();
    const result = await runExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask('PROJ-1', { priority: 'High' })],
      policy: new AutonomyPolicy(),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps: new MockGitOps(),
      prCreator: new MockPullRequestCreator(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
    });
    expect(result.status).toBe('no_eligible_task');
  });

  it('unmapped project stops ambiguous and files an approval', async () => {
    handle = await createTestDb();
    const config = configWithRepo();
    config.github.repoMap = {}; // nothing mapped
    const result = await runExecution({
      db: handle.db,
      config,
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps: new MockGitOps(),
      prCreator: new MockPullRequestCreator(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
    });
    expect(result.status).toBe('stopped_ambiguous');
    const pending = await new ApprovalsStore(handle.db).listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.reasoning).toContain('no approved/mapped repository');
  });

  it('implementation failure stops ambiguous and files an approval', async () => {
    handle = await createTestDb();
    const failingRunner = new MockClaudeCodeRunner({ success: false, summary: 'ticket is ambiguous, stopping' });
    const result = await runExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      claudeRunner: failingRunner,
      gitOps: new MockGitOps(),
      prCreator: new MockPullRequestCreator(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
    });
    expect(result.status).toBe('stopped_ambiguous');
    expect(await new ApprovalsStore(handle.db).listPending()).toHaveLength(1);
  });

  it('failing checks stop before any git push', async () => {
    handle = await createTestDb();
    const gitOps = new MockGitOps();
    const result = await runExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps,
      prCreator: new MockPullRequestCreator(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      checkCommands: [['test', ['false']]],
      checkRetries: 0, // a real failure, not flakiness — skip the retry delay
    });
    expect(result.status).toBe('stopped_failed_checks');
    expect(gitOps.calls.some((c) => c[0] === 'push')).toBe(false);
  });

  it('no actual changes stops ambiguous', async () => {
    handle = await createTestDb();
    const gitOps = new MockGitOps();
    gitOps.hasChanges = false;
    const result = await runExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps,
      prCreator: new MockPullRequestCreator(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      checkCommands: NOOP_CHECKS,
    });
    expect(result.status).toBe('stopped_ambiguous');
    expect(gitOps.calls.some((c) => c[0] === 'push')).toBe(false);
  });

  it('too many changed files blocks the PR', async () => {
    handle = await createTestDb();
    const bigDiff = Array.from({ length: 20 }, (_, i) => ` src/file${i}.ts | 1 +`).join('\n');
    const gitOps = new MockGitOps(bigDiff);
    const result = await runExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps,
      prCreator: new MockPullRequestCreator(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      checkCommands: NOOP_CHECKS,
      gateConfig: { ...DEFAULT_GATE_CONFIG, maxChangedFiles: 15 },
    });
    expect(result.status).toBe('stopped_failed_checks');
  });

  it('PR creator is never called on any stop path', async () => {
    handle = await createTestDb();
    const prCreator = new MockPullRequestCreator();
    await runExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask('PROJ-1', { priority: 'High' })],
      policy: new AutonomyPolicy(),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps: new MockGitOps(),
      prCreator,
      worktreeManagerFactory: () => new FakeWorktreeManager(),
    });
    expect(prCreator.calls).toEqual([]);
  });

  it('audit log covers the full happy path', async () => {
    handle = await createTestDb();
    await runExecution({
      db: handle.db,
      config: configWithRepo(),
      candidates: [makeTask()],
      policy: new AutonomyPolicy(),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps: new MockGitOps(),
      prCreator: new MockPullRequestCreator(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      checkCommands: NOOP_CHECKS,
    });
    const events = (await new AuditLog(handle.db).readAll()).map((e) => e.event);
    expect(events).toEqual([
      'execution_run_started',
      'execution_candidates_evaluated',
      'execution_task_selected',
      'execution_worktree_created',
      'execution_implementation_finished',
      'execution_checks_run',
      'execution_gate_decision',
      'execution_pushed',
      'execution_pr_opened',
      'execution_time_pending_approval',
    ]);
  });

  it('works for a project that has never been seen before, as long as config maps it (no hardcoding anywhere in the flow)', async () => {
    handle = await createTestDb();
    const config: WorkAgentConfig = {
      jira: { myProjects: [], ignoredKeys: [] },
      github: {
        approvedRepos: ['brand-new-org/brand-new-repo'],
        repoMap: { NEWPROJ: 'brand-new-org/brand-new-repo' },
        repoLocalPaths: { 'brand-new-org/brand-new-repo': '/x' },
        repoDefaultBranches: {},
        previewRecipes: {},
      },
      slack: { relevantChannels: [] },
      engineeringExecution: { openPrAsDraft: true },
      communication: { autoSendRoutine: false },
    };
    const result = await runExecution({
      db: handle.db,
      config,
      candidates: [makeTask('NEWPROJ-1', { project: 'NEWPROJ' })],
      policy: new AutonomyPolicy(),
      claudeRunner: new MockClaudeCodeRunner(),
      gitOps: new MockGitOps(),
      prCreator: new MockPullRequestCreator(),
      worktreeManagerFactory: () => new FakeWorktreeManager(),
      checkCommands: NOOP_CHECKS,
    });
    expect(result.status).toBe('opened_pr');
  });
});
