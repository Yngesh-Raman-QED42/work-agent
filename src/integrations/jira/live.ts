import { extractGitHubPrRefs, type JiraIssue } from '../../models/types.js';
import type { JiraConnector } from '../types.js';
import type { JiraDetailReader, TaskContext } from './detail.js';

const JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';

/**
 * Read-only Jira Cloud REST v3 client. Only ever issues GET requests — there
 * is no write/edit method here, deliberately, for Phase 1.
 */
export class LiveJiraConnector implements JiraConnector, JiraDetailReader {
  private baseUrl: string;
  private email: string;
  private apiToken: string;

  constructor(opts?: { baseUrl?: string; email?: string; apiToken?: string }) {
    this.baseUrl = (opts?.baseUrl ?? process.env.JIRA_BASE_URL ?? '').replace(/\/$/, '');
    this.email = opts?.email ?? process.env.JIRA_EMAIL ?? '';
    this.apiToken = opts?.apiToken ?? process.env.JIRA_API_TOKEN ?? '';
    if (!this.baseUrl || !this.email || !this.apiToken) {
      throw new Error('LiveJiraConnector requires JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN');
    }
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.email}:${this.apiToken}`).toString('base64');
  }

  async fetchMyOpenIssues(): Promise<JiraIssue[]> {
    const url = new URL(`${this.baseUrl}/rest/api/3/search/jql`);
    url.searchParams.set('jql', JQL);
    url.searchParams.set('maxResults', '100');
    // `comment` and `description` are included so a GitHub PR URL pasted
    // into either (the common way people actually link a PR from Jira's
    // side — see correlate.ts) can be found, without a second per-issue
    // request for every ticket on every observation cycle.
    url.searchParams.set('fields', 'summary,status,priority,updated,project,comment,description');

    const resp = await fetch(url, {
      headers: { Authorization: this.authHeader(), Accept: 'application/json' },
    });
    if (!resp.ok) {
      throw new Error(`Jira search failed: ${resp.status} ${await resp.text()}`);
    }
    const data = (await resp.json()) as {
      issues: Array<{
        key: string;
        fields: {
          summary: string;
          status: { name: string; statusCategory: { name: string } };
          priority?: { name: string };
          updated: string;
          project: { key: string };
          description?: string | { content?: unknown } | null;
          comment?: { comments: Array<{ body: unknown }> };
        };
      }>;
    };

    return data.issues.map((node) => {
      const commentText = (node.fields.comment?.comments ?? [])
        .map((c) => adfOrTextToPlain(c.body as string | { content?: unknown } | null))
        .join(' ');
      const descriptionText = adfOrTextToPlain(node.fields.description);
      const linkedPrRefs = extractGitHubPrRefs(descriptionText, commentText);

      return {
        key: node.key,
        project: node.fields.project.key,
        summary: node.fields.summary,
        status: node.fields.status.name,
        statusCategory: node.fields.status.statusCategory.name,
        priority: node.fields.priority?.name ?? 'None',
        updated: node.fields.updated,
        url: `${this.baseUrl}/browse/${node.key}`,
        ...(linkedPrRefs.length > 0 ? { linkedPrRefs } : {}),
      };
    });
  }

  async fetchIssueDetail(key: string): Promise<TaskContext> {
    const url = new URL(`${this.baseUrl}/rest/api/3/issue/${key}`);
    url.searchParams.set('fields', 'summary,description,status,priority,issuetype,project,comment');

    const resp = await fetch(url, { headers: { Authorization: this.authHeader(), Accept: 'application/json' } });
    if (!resp.ok) {
      throw new Error(`Jira issue fetch failed: ${resp.status} ${await resp.text()}`);
    }
    const data = (await resp.json()) as {
      key: string;
      fields: {
        summary: string;
        description: string | { content?: unknown } | null;
        status: { name: string };
        priority?: { name: string };
        issuetype: { name: string };
        project: { key: string };
        comment?: { comments: Array<{ author: { displayName: string }; body: unknown }> };
      };
    };

    return {
      key: data.key,
      project: data.fields.project.key,
      summary: data.fields.summary,
      description: adfOrTextToPlain(data.fields.description),
      issueType: data.fields.issuetype.name,
      status: data.fields.status.name,
      priority: data.fields.priority?.name ?? 'None',
      url: `${this.baseUrl}/browse/${data.key}`,
      comments: (data.fields.comment?.comments ?? []).map((c) => ({
        author: c.author.displayName,
        body: adfOrTextToPlain(c.body as string | { content?: unknown } | null),
      })),
    };
  }
}

/** Jira Cloud v3 returns description/comment bodies as Atlassian Document
 * Format (rich JSON) unless requested otherwise; this does a best-effort
 * plain-text flatten (enough for keyword/policy scanning) rather than
 * pulling in a full ADF renderer for what's currently just text analysis. */
function adfOrTextToPlain(value: string | { content?: unknown } | null | undefined): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (n.type === 'text' && n.text) parts.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(value);
  return parts.join(' ');
}
