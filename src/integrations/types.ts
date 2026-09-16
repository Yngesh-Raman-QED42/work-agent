import type { GitHubPr, JiraIssue, SlackMessage } from '../models/types.js';

/** Read-only. No method on any implementation of these may write anywhere. */
export interface SlackConnector {
  fetchRelevantMessages(opts: { lookbackHours: number }): Promise<SlackMessage[]>;
}

export interface JiraConnector {
  fetchMyOpenIssues(): Promise<JiraIssue[]>;
}

export interface GitHubConnector {
  fetchMyPullRequests(): Promise<GitHubPr[]>;
}
