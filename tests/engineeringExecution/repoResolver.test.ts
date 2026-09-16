import { describe, expect, it } from 'vitest';
import { resolveRepo } from '../../src/agents/engineeringExecution/repoResolver.js';
import type { WorkAgentConfig } from '../../src/config/index.js';

function baseConfig(overrides: Partial<WorkAgentConfig['github']> = {}): WorkAgentConfig {
  return {
    jira: { myProjects: [] },
    github: { approvedRepos: [], repoMap: {}, repoLocalPaths: {}, repoDefaultBranches: {}, previewRecipes: {}, ...overrides },
    slack: { relevantChannels: [] },
    communication: { autoSendRoutine: false },
  };
}

describe('resolveRepo', () => {
  it('resolves a fully-configured project to its repo, whatever that project happens to be', () => {
    const config = baseConfig({
      approvedRepos: ['some-org/brand-new-repo'],
      repoMap: { BRANDNEW: 'some-org/brand-new-repo' },
      repoLocalPaths: { 'some-org/brand-new-repo': '/home/user/brand-new-repo' },
    });
    const repo = resolveRepo(config, 'BRANDNEW');
    expect(repo).toEqual({
      projectKey: 'BRANDNEW',
      owner: 'some-org',
      repo: 'brand-new-repo',
      localPath: '/home/user/brand-new-repo',
      defaultBranch: 'main',
    });
  });

  it('returns null for a project with no mapping at all (never guesses)', () => {
    const config = baseConfig();
    expect(resolveRepo(config, 'UNMAPPED')).toBeNull();
  });

  it('returns null when mapped but not in approvedRepos', () => {
    const config = baseConfig({ repoMap: { PROJ: 'org/repo' }, repoLocalPaths: { 'org/repo': '/x' } });
    expect(resolveRepo(config, 'PROJ')).toBeNull();
  });

  it('returns null when approved and mapped but no local clone path is known', () => {
    const config = baseConfig({ approvedRepos: ['org/repo'], repoMap: { PROJ: 'org/repo' } });
    expect(resolveRepo(config, 'PROJ')).toBeNull();
  });

  it('honors a configured non-default default branch', () => {
    const config = baseConfig({
      approvedRepos: ['org/repo'],
      repoMap: { PROJ: 'org/repo' },
      repoLocalPaths: { 'org/repo': '/x' },
      repoDefaultBranches: { 'org/repo': 'develop' },
    });
    expect(resolveRepo(config, 'PROJ')?.defaultBranch).toBe('develop');
  });
});
