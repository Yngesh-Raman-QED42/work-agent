import { describe, expect, it, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { loadConfig } from '../src/config/index.js';

const TMP_CONFIG_PATH = 'tests/.tmp-work-agent.config.json';

afterEach(() => {
  if (existsSync(TMP_CONFIG_PATH)) unlinkSync(TMP_CONFIG_PATH);
});

describe('loadConfig', () => {
  it('has no project/repo hardcoded into the app defaults when no config file exists', () => {
    const config = loadConfig('this-file-does-not-exist.json');
    expect(config.jira.myProjects).toEqual([]);
    expect(config.github.approvedRepos).toEqual([]);
    expect(config.github.repoMap).toEqual({});
  });

  it('picks up whatever project/repo mappings the user has actually configured', () => {
    writeFileSync(
      TMP_CONFIG_PATH,
      JSON.stringify({
        github: {
          approvedRepos: ['some-org/some-new-repo'],
          repoMap: { NEWPROJ: 'some-org/some-new-repo' },
        },
      }),
    );
    const config = loadConfig(TMP_CONFIG_PATH);
    expect(config.github.repoMap).toEqual({ NEWPROJ: 'some-org/some-new-repo' });
    expect(config.github.approvedRepos).toEqual(['some-org/some-new-repo']);
  });

  it('an unmapped project is simply absent from repoMap, not defaulted to anything', () => {
    writeFileSync(TMP_CONFIG_PATH, JSON.stringify({ github: { repoMap: { ONEPROJ: 'org/repo' } } }));
    const config = loadConfig(TMP_CONFIG_PATH);
    expect(config.github.repoMap['SOME_OTHER_PROJECT']).toBeUndefined();
  });
});
