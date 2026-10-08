export interface JiraComment {
  author: string;
  body: string;
}

export interface TaskContext {
  key: string;
  project: string;
  summary: string;
  description: string;
  issueType: string;
  status: string;
  priority: string;
  url: string;
  comments: JiraComment[];
  // Only populated when `key` is a story-level ticket with real sub-tasks
  // under it (see LiveJiraConnector.fetchIssueDetail) — each one's own full
  // detail (not just the lightweight {key, summary} Jira's own "subtasks"
  // field returns), so Engineering Execution can hand the whole group to
  // one branch/PR instead of starting a separate one per sub-task. Absent
  // or empty for an ordinary Task/Bug — every existing caller that only
  // ever dealt with a single ticket keeps working unchanged.
  subtasks?: TaskContext[];
}

export function taskFullText(task: TaskContext): string {
  return [task.summary, task.description, ...task.comments.map((c) => c.body)].filter(Boolean).join('\n');
}

/** Fetches the full detail (description, comments) a Jira summary-only fetch
 * doesn't have — needed before deciding whether a ticket is clear enough to
 * hand to the Engineering Execution agent. */
export interface JiraDetailReader {
  fetchIssueDetail(key: string): Promise<TaskContext>;
}
