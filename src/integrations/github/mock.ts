import type { GitHubPr } from '../../models/types.js';
import type { GitHubConnector } from '../types.js';

export function defaultFixturePrs(): GitHubPr[] {
  return [
    {
      repo: 'qed42/operational-intelligence',
      number: 101,
      title: 'QED42OPSIN-59: fix capacity planner search ranking',
      url: 'https://github.com/qed42/operational-intelligence/pull/101',
      state: 'open',
      isDraft: false,
      branch: 'fix/qed42opsin-59-search-ranking',
      isAuthor: true,
      reviewRequestedOfMe: false,
      reviewState: 'changes_requested',
      updatedAt: '2026-09-06T09:15:00+05:30',
    },
    {
      repo: 'qed42/operational-intelligence',
      number: 97,
      title: 'Add export/download for filtered timesheet reports',
      url: 'https://github.com/qed42/operational-intelligence/pull/97',
      state: 'open',
      isDraft: false,
      branch: 'feature/timesheet-export',
      isAuthor: true,
      reviewRequestedOfMe: false,
      reviewState: 'none',
      updatedAt: '2026-09-04T18:00:00+05:30',
    },
    {
      repo: 'qed42/operational-intelligence',
      number: 59,
      title: 'QED42OPSIN-60: Fix overlapping allocation labels in frozen panel during scroll',
      url: 'https://github.com/qed42/operational-intelligence/pull/59',
      state: 'open',
      isDraft: true,
      branch: 'work-agent/qed42opsin-60',
      isAuthor: true,
      reviewRequestedOfMe: false,
      reviewState: 'none',
      updatedAt: '2026-09-09T21:00:00+05:30',
    },
  ];
}

export class MockGitHubConnector implements GitHubConnector {
  constructor(private prs: GitHubPr[] = defaultFixturePrs()) {}

  async fetchMyPullRequests(): Promise<GitHubPr[]> {
    return [...this.prs];
  }
}
