import { describe, expect, it, afterEach } from 'vitest';
import { buildConnectors } from '../../src/integrations/factory.js';
import { LiveJiraConnector } from '../../src/integrations/jira/live.js';
import { MockJiraConnector } from '../../src/integrations/jira/mock.js';
import { LiveSlackConnector } from '../../src/integrations/slack/live.js';
import { MockSlackConnector } from '../../src/integrations/slack/mock.js';
import type { WorkAgentConfig } from '../../src/config/index.js';

const ENV_KEYS = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'SLACK_USER_TOKEN', 'SLACK_USER_ID'] as const;

function testConfig(): WorkAgentConfig {
  return {
    jira: { myProjects: [], ignoredKeys: [] },
    github: { approvedRepos: [], repoMap: {}, repoLocalPaths: {}, repoDefaultBranches: {}, previewRecipes: {} },
    slack: { relevantChannels: [] },
    communication: { autoSendRoutine: false },
  };
}

describe('buildConnectors (auto mode)', () => {
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function clearCreds() {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }

  it('falls back to mock for Jira/Slack when no credentials are present', () => {
    clearCreds();
    const { connectors, resolved } = buildConnectors(testConfig(), 'auto');
    expect(resolved.jira).toBe('mock');
    expect(resolved.slack).toBe('mock');
    expect(connectors.jira).toBeInstanceOf(MockJiraConnector);
    expect(connectors.slack).toBeInstanceOf(MockSlackConnector);
  });

  it('goes live for Jira automatically once its credentials exist', () => {
    clearCreds();
    process.env.JIRA_BASE_URL = 'https://example.atlassian.net';
    process.env.JIRA_EMAIL = 'x@example.com';
    process.env.JIRA_API_TOKEN = 'fake-token';

    const { connectors, resolved } = buildConnectors(testConfig(), 'auto');
    expect(resolved.jira).toBe('live');
    expect(connectors.jira).toBeInstanceOf(LiveJiraConnector);
    expect(resolved.slack).toBe('mock'); // still no Slack creds
  });

  it('goes live for Slack automatically once its credentials exist', () => {
    clearCreds();
    process.env.SLACK_USER_TOKEN = 'xoxp-fake';
    process.env.SLACK_USER_ID = 'U123';

    const { connectors, resolved } = buildConnectors(testConfig(), 'auto');
    expect(resolved.slack).toBe('live');
    expect(connectors.slack).toBeInstanceOf(LiveSlackConnector);
  });

  it('GitHub is live by default regardless of env vars (no credential gate — uses gh CLI)', () => {
    clearCreds();
    const { resolved } = buildConnectors(testConfig(), 'auto');
    expect(resolved.github).toBe('live');
  });

  it('an explicit "mock" mode forces everything to mock even with credentials present', () => {
    clearCreds();
    process.env.JIRA_BASE_URL = 'https://example.atlassian.net';
    process.env.JIRA_EMAIL = 'x@example.com';
    process.env.JIRA_API_TOKEN = 'fake-token';

    const { resolved } = buildConnectors(testConfig(), 'mock');
    expect(resolved.jira).toBe('mock');
    expect(resolved.github).toBe('mock');
    expect(resolved.slack).toBe('mock');
  });

  it('an explicit "live" mode fails loudly (not silently) if credentials are actually missing', () => {
    clearCreds();
    expect(() => buildConnectors(testConfig(), 'live')).toThrow(/JIRA_BASE_URL/);
  });

  it('an explicit "live" mode resolves all three when credentials genuinely exist', () => {
    clearCreds();
    process.env.JIRA_BASE_URL = 'https://example.atlassian.net';
    process.env.JIRA_EMAIL = 'x@example.com';
    process.env.JIRA_API_TOKEN = 'fake-token';
    process.env.SLACK_USER_TOKEN = 'xoxp-fake';
    process.env.SLACK_USER_ID = 'U123';

    const { resolved } = buildConnectors(testConfig(), 'live');
    expect(resolved.jira).toBe('live');
    expect(resolved.slack).toBe('live');
    expect(resolved.github).toBe('live');
  });
});
