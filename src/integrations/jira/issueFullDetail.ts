// Powers the dashboard's ticket-detail dialog — deliberately a separate,
// richer read path from detail.ts's TaskContext (used by Task
// Intelligence/Engineering Execution, which only ever need summary +
// description + comments to decide eligibility). This one exists purely to
// answer "what does the Jira page itself show," so a person can look at
// this instead of opening Jira — assignee/reporter, dates, time tracking,
// attachments, and comments rendered as real HTML, not flattened text.

import { adfToHtml, adfToPlainText } from './adf.js';

export interface JiraAttachment {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  author: string;
  created: string;
}

export interface JiraCommentDetail {
  id: string;
  author: string;
  created: string;
  bodyHtml: string;
}

export interface JiraWorklogEntry {
  id: string;
  author: string;
  started: string;
  timeSpent: string;
  comment: string | null;
}

export interface JiraFullDetail {
  key: string;
  url: string;
  summary: string;
  descriptionHtml: string;
  descriptionPlain: string;
  status: string;
  priority: string;
  issueType: string;
  project: string;
  assignee: string | null;
  reporter: string | null;
  created: string;
  updated: string;
  labels: string[];
  components: string[];
  originalEstimate: string | null;
  remainingEstimate: string | null;
  timeSpent: string | null;
  attachments: JiraAttachment[];
  comments: JiraCommentDetail[];
  worklogs: JiraWorklogEntry[];
}

export interface JiraFullDetailReader {
  fetchFullDetail(key: string): Promise<JiraFullDetail>;
}

interface RawIssueResponse {
  key: string;
  fields: {
    summary: string;
    description: unknown;
    status: { name: string };
    priority?: { name: string };
    issuetype: { name: string };
    project: { key: string };
    assignee?: { displayName: string } | null;
    reporter?: { displayName: string } | null;
    created: string;
    updated: string;
    labels?: string[];
    components?: Array<{ name: string }>;
    timetracking?: { originalEstimate?: string; remainingEstimate?: string; timeSpent?: string };
    attachment?: Array<{ id: string; filename: string; size: number; mimeType: string; author: { displayName: string }; created: string }>;
    comment?: { comments: Array<{ id: string; author: { displayName: string }; created: string; body: unknown }> };
  };
}

interface RawWorklogResponse {
  worklogs: Array<{
    id: string;
    author: { displayName: string };
    started: string;
    timeSpent: string;
    comment?: unknown;
  }>;
}

export class LiveJiraFullDetailReader implements JiraFullDetailReader {
  private baseUrl: string;
  private email: string;
  private apiToken: string;

  constructor(opts?: { baseUrl?: string; email?: string; apiToken?: string }) {
    this.baseUrl = (opts?.baseUrl ?? process.env.JIRA_BASE_URL ?? '').replace(/\/$/, '');
    this.email = opts?.email ?? process.env.JIRA_EMAIL ?? '';
    this.apiToken = opts?.apiToken ?? process.env.JIRA_API_TOKEN ?? '';
    if (!this.baseUrl || !this.email || !this.apiToken) {
      throw new Error('LiveJiraFullDetailReader requires JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN');
    }
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.email}:${this.apiToken}`).toString('base64');
  }

  async fetchFullDetail(key: string): Promise<JiraFullDetail> {
    const fields = [
      'summary', 'description', 'status', 'priority', 'issuetype', 'project',
      'assignee', 'reporter', 'created', 'updated', 'labels', 'components',
      'timetracking', 'attachment', 'comment',
    ].join(',');
    const issueUrl = new URL(`${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}`);
    issueUrl.searchParams.set('fields', fields);

    const [issueResp, worklogResp] = await Promise.all([
      fetch(issueUrl, { headers: { Authorization: this.authHeader(), Accept: 'application/json' } }),
      fetch(`${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/worklog`, {
        headers: { Authorization: this.authHeader(), Accept: 'application/json' },
      }),
    ]);
    if (!issueResp.ok) throw new Error(`Jira issue fetch failed for ${key}: ${issueResp.status} ${await issueResp.text()}`);
    if (!worklogResp.ok) throw new Error(`Jira worklog fetch failed for ${key}: ${worklogResp.status} ${await worklogResp.text()}`);

    const data = (await issueResp.json()) as RawIssueResponse;
    const worklogData = (await worklogResp.json()) as RawWorklogResponse;
    const f = data.fields;

    return {
      key: data.key,
      url: `${this.baseUrl}/browse/${data.key}`,
      summary: f.summary,
      descriptionHtml: adfToHtml(f.description),
      descriptionPlain: adfToPlainText(f.description),
      status: f.status.name,
      priority: f.priority?.name ?? 'None',
      issueType: f.issuetype.name,
      project: f.project.key,
      assignee: f.assignee?.displayName ?? null,
      reporter: f.reporter?.displayName ?? null,
      created: f.created,
      updated: f.updated,
      labels: f.labels ?? [],
      components: (f.components ?? []).map((c) => c.name),
      originalEstimate: f.timetracking?.originalEstimate ?? null,
      remainingEstimate: f.timetracking?.remainingEstimate ?? null,
      timeSpent: f.timetracking?.timeSpent ?? null,
      attachments: (f.attachment ?? []).map((a) => ({
        id: a.id,
        filename: a.filename,
        size: a.size,
        mimeType: a.mimeType,
        author: a.author.displayName,
        created: a.created,
      })),
      comments: (f.comment?.comments ?? []).map((c) => ({
        id: c.id,
        author: c.author.displayName,
        created: c.created,
        bodyHtml: adfToHtml(c.body),
      })),
      worklogs: worklogData.worklogs.map((w) => ({
        id: w.id,
        author: w.author.displayName,
        started: w.started,
        timeSpent: w.timeSpent,
        comment: w.comment ? adfToPlainText(w.comment) : null,
      })),
    };
  }
}

export class MockJiraFullDetailReader implements JiraFullDetailReader {
  constructor(private details: Record<string, JiraFullDetail>) {}

  async fetchFullDetail(key: string): Promise<JiraFullDetail> {
    const detail = this.details[key];
    if (!detail) throw new Error(`no fixture detail for ${key}`);
    return detail;
  }
}
