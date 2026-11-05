import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createServer } from 'node:net';
import {
  detectTechStack,
  probePort,
  matchDockerContainers,
  buildProjectOverview,
  type DockerContainer,
} from '../../src/dashboard/projectOverview.js';
import type { WorkAgentConfig } from '../../src/config/index.js';

let tmpDir: string;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function configWith(overrides: Partial<WorkAgentConfig['github']> = {}): WorkAgentConfig {
  return {
    jira: { myProjects: [], ignoredKeys: [] },
    github: { approvedRepos: [], repoMap: {}, repoLocalPaths: {}, repoDefaultBranches: {}, previewRecipes: {}, ...overrides },
    slack: { relevantChannels: [] },
    engineeringExecution: { openPrAsDraft: true },
    communication: { autoSendRoutine: false },
    dashboard: { terminalOs: 'ubuntu' },
  };
}

describe('detectTechStack', () => {
  it('reads real dependency names out of package.json and labels only the ones it recognizes', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tech-stack-'));
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { next: '14.0.0', react: '18.0.0', 'left-pad': '1.0.0' }, devDependencies: { vitest: '1.0.0' } }),
    );
    const stack = detectTechStack(tmpDir);
    expect(stack).toEqual(expect.arrayContaining(['Next.js', 'React', 'Vitest']));
    expect(stack).not.toContain('left-pad');
  });

  it('returns [] when there is no package.json, never throws', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tech-stack-'));
    expect(detectTechStack(tmpDir)).toEqual([]);
  });

  it('returns [] when package.json is not valid JSON, never throws', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tech-stack-'));
    writeFileSync(join(tmpDir, 'package.json'), 'not json{{{');
    expect(detectTechStack(tmpDir)).toEqual([]);
  });
});

describe('probePort', () => {
  it('resolves true when something is actually listening', async () => {
    const server = createServer().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await probePort(port)).toBe(true);
    } finally {
      server.close();
    }
  });

  it('resolves false when nothing is listening, never throws or hangs', async () => {
    // Port 1 is a privileged, essentially-never-bound port — safe to assume closed in CI.
    expect(await probePort(1, '127.0.0.1', 200)).toBe(false);
  });
});

describe('matchDockerContainers', () => {
  const containers: DockerContainer[] = [
    { name: 'ddev-learningskillsanddatafe-web', status: 'Up 2 hours' },
    { name: 'some-unrelated-container', status: 'Up 1 day' },
  ];

  it('matches a container whose name contains the repo directory name, ignoring case/punctuation', () => {
    const matched = matchDockerContainers(containers, '/home/me/Desktop/UNLSD/LearningSkillsAndDataFE');
    expect(matched).toEqual([{ name: 'ddev-learningskillsanddatafe-web', status: 'Up 2 hours' }]);
  });

  it('returns [] when nothing matches — never a wrong guess', () => {
    expect(matchDockerContainers(containers, '/home/me/some-other-project')).toEqual([]);
  });
});

describe('buildProjectOverview', () => {
  it('composes tech stack, backend description, local URL, and docker status from real config', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'overview-'));
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ dependencies: { next: '1.0.0' } }));
    const config = configWith({
      repoLocalPaths: { 'org/repo': tmpDir },
      backendSync: { 'org/repo': { command: ['true'], timeoutMs: 1000, onFailure: 'warn', description: 'Drupal backend (DDEV)' } },
      previewRecipes: { 'org/repo': { startCommand: ['npm', 'run', 'dev'], port: 1, readyPath: '/', readyTimeoutMs: 1000, env: {} } },
    });
    const overview = await buildProjectOverview('org/repo', config, [{ name: `some-${basename(tmpDir)}-web`, status: 'Up' }]);
    expect(overview.techStack).toContain('Next.js');
    expect(overview.backendDescription).toBe('Drupal backend (DDEV)');
    expect(overview.localUrl).toBe('http://localhost:1');
    expect(overview.localUrlLive).toBe(false); // nothing really listening on port 1
    expect(overview.dockerContainers).toHaveLength(1);
  });

  it('degrades gracefully to empty/undefined fields when nothing is configured for this repo', async () => {
    const overview = await buildProjectOverview('org/unmapped-repo', configWith(), []);
    expect(overview.techStack).toEqual([]);
    expect(overview.backendDescription).toBeUndefined();
    expect(overview.localUrl).toBeUndefined();
    expect(overview.localUrlLive).toBe(false);
    expect(overview.dockerContainers).toEqual([]);
  });
});
