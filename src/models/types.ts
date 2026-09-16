export const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;

export function extractJiraKeys(...texts: (string | null | undefined)[]): string[] {
  const keys: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(JIRA_KEY_RE)) {
      const key = match[1]!;
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

export interface SlackMessage {
  channel: string;
  channelName: string;
  ts: string;
  user: string;
  text: string;
  permalink: string;
  threadTs?: string | null;
  mentionsMe: boolean;
}

export function slackMessageJiraKeys(msg: SlackMessage): string[] {
  return extractJiraKeys(msg.text);
}

export interface JiraIssue {
  key: string;
  project: string;
  summary: string;
  status: string;
  statusCategory: string; // "To Do" | "In Progress" | "Done"
  priority: string;
  updated: string; // ISO timestamp
  url: string;
  // PRs explicitly linked from the Jira side — e.g. a GitHub PR URL pasted
  // into a comment or the description — found by scanning ticket text
  // rather than by Jira's dev-status/remote-link integrations (which
  // require an app most orgs don't have installed, and were empty even for
  // a ticket that clearly did have a linked PR — see correlate.ts).
  linkedPrRefs?: GitHubPrRef[];
}

export interface GitHubPrRef {
  repo: string; // "owner/repo"
  number: number;
}

const GITHUB_PR_URL_RE = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;

export function extractGitHubPrRefs(...texts: (string | null | undefined)[]): GitHubPrRef[] {
  const refs: GitHubPrRef[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(GITHUB_PR_URL_RE)) {
      const ref = { repo: match[1]!, number: Number(match[2]) };
      if (!refs.some((r) => r.repo === ref.repo && r.number === ref.number)) refs.push(ref);
    }
  }
  return refs;
}

export interface GitHubPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  branch: string;
  isAuthor: boolean;
  reviewRequestedOfMe: boolean;
  reviewState: 'none' | 'changes_requested' | 'approved' | 'commented';
  updatedAt: string;
}

export function prJiraKeys(pr: GitHubPr): string[] {
  return extractJiraKeys(pr.title, pr.branch);
}

export type Category = 'needs_review' | 'needs_action' | 'blocked' | 'waiting_on_others' | 'slack_mention' | 'fyi';
export type Urgency = 'high' | 'medium' | 'low';

export interface WorkItem {
  id: string;
  jira: JiraIssue | null;
  prs: GitHubPr[];
  slackMessages: SlackMessage[];
  category: Category;
  urgency: Urgency;
  reasons: string[];
}

export function workItemLabel(item: WorkItem): string {
  return item.jira?.key ?? item.id;
}

export function workItemSummary(item: WorkItem): string {
  if (item.jira) return item.jira.summary;
  if (item.prs[0]) return item.prs[0].title;
  if (item.slackMessages[0]) return item.slackMessages[0].text.replace(/\n/g, ' ').slice(0, 100);
  return '(no summary)';
}
