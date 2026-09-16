import type { WorkAgentConfig } from '../config/index.js';
import type { GitHubConnector, JiraConnector, SlackConnector } from './types.js';
import { MockSlackConnector } from './slack/mock.js';
import { MockJiraConnector } from './jira/mock.js';
import { MockGitHubConnector } from './github/mock.js';
import { LiveJiraConnector } from './jira/live.js';
import { LiveGitHubConnector } from './github/live.js';
import { LiveSlackConnector } from './slack/live.js';

export type ConnectorMode = 'auto' | 'mock' | 'live';
export type ResolvedMode = 'live' | 'mock';

export interface ConnectorSet {
  jira: JiraConnector;
  slack: SlackConnector;
  github: GitHubConnector;
}

export interface ConnectorBuildResult {
  connectors: ConnectorSet;
  resolved: Record<'jira' | 'slack' | 'github', ResolvedMode>;
}

function hasJiraCredentials(): boolean {
  return !!(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);
}

function hasSlackCredentials(): boolean {
  return !!(process.env.SLACK_USER_TOKEN && process.env.SLACK_USER_ID);
}

/**
 * Builds each connector INDEPENDENTLY rather than one global mock/live
 * switch for all three — otherwise, since Slack has no credential yet,
 * forcing "live" to get real Jira/GitHub data would crash the whole
 * command. In "auto" (the default), each connector goes live the moment
 * its own credentials exist — no flag to flip, no all-or-nothing failure.
 * GitHub has no credential gate at all (the `gh` CLI is always available
 * here), so it's live unless mock is explicitly forced.
 */
export function buildConnectors(config: WorkAgentConfig, mode: ConnectorMode = 'auto'): ConnectorBuildResult {
  const jiraLive = mode === 'live' || (mode === 'auto' && hasJiraCredentials());
  const slackLive = mode === 'live' || (mode === 'auto' && hasSlackCredentials());
  const githubLive = mode !== 'mock';

  return {
    connectors: {
      jira: jiraLive ? new LiveJiraConnector() : new MockJiraConnector(),
      slack: slackLive ? new LiveSlackConnector() : new MockSlackConnector(),
      github: githubLive ? new LiveGitHubConnector(config.github.approvedRepos) : new MockGitHubConnector(),
    },
    resolved: {
      jira: jiraLive ? 'live' : 'mock',
      slack: slackLive ? 'live' : 'mock',
      github: githubLive ? 'live' : 'mock',
    },
  };
}
