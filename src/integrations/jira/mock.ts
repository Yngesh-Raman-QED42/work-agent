import type { JiraIssue } from '../../models/types.js';
import type { JiraConnector } from '../types.js';
import type { JiraDetailReader, TaskContext } from './detail.js';

export function defaultFixtureIssues(): JiraIssue[] {
  return [
    {
      key: 'QED42OPSIN-59',
      project: 'QED42OPSIN',
      summary: 'Capacity Planner | Fix Capacity Planner Search Results',
      status: 'In Progress',
      statusCategory: 'In Progress',
      priority: 'Medium',
      updated: '2026-09-05T10:00:00+05:30',
      url: 'https://qed42-operations.atlassian.net/browse/QED42OPSIN-59',
    },
    {
      key: 'QED42OPSIN-56',
      project: 'QED42OPSIN',
      summary: 'Timesheet: Add Report Export/Download Functionality for Filtered Data',
      status: 'Ready for QA',
      statusCategory: 'In Progress',
      priority: 'High',
      updated: '2026-09-04T16:20:00+05:30',
      url: 'https://qed42-operations.atlassian.net/browse/QED42OPSIN-56',
    },
    {
      key: 'QCBP-368',
      project: 'QCBP',
      summary: 'Slack AI assistant with AI Agents and MCP',
      status: 'On Hold',
      statusCategory: 'In Progress',
      priority: 'Medium',
      updated: '2026-08-20T12:00:00+05:30',
      url: 'https://qed42-operations.atlassian.net/browse/QCBP-368',
    },
    {
      key: 'QGP-463',
      project: 'QGP',
      summary: 'DevForge AI App Generation Platform - MVP Development',
      status: 'Backlog',
      statusCategory: 'To Do',
      priority: 'Medium',
      updated: '2026-08-01T09:00:00+05:30',
      url: 'https://qed42-operations.atlassian.net/browse/QGP-463',
    },
  ];
}

export class MockJiraConnector implements JiraConnector {
  constructor(private issues: JiraIssue[] = defaultFixtureIssues()) {}

  async fetchMyOpenIssues(): Promise<JiraIssue[]> {
    return [...this.issues];
  }
}

export class MockJiraDetailReader implements JiraDetailReader {
  constructor(private details: Record<string, TaskContext> = {}) {}

  async fetchIssueDetail(key: string): Promise<TaskContext> {
    const detail = this.details[key];
    if (!detail) throw new Error(`MockJiraDetailReader has no fixture for ${key}`);
    return detail;
  }

  set(key: string, detail: TaskContext): void {
    this.details[key] = detail;
  }
}
