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
