// Deliberately NOT part of JiraConnector (src/integrations/types.ts), which
// is documented read-only. This is a separate, explicit write surface, in
// the same spirit as worklogWriter.ts — used only from Engineering
// Execution's own start/finish steps, never from anything read-only.

import { textWithLinksToAdf } from './adf.js';

export interface JiraTransition {
  id: string;
  name: string;
  to: { name: string };
}

export interface JiraIssueUpdater {
  /** A plain-text comment, optionally followed by one or more clickable
   * links (e.g. the PR this comment is announcing). */
  addComment(key: string, text: string, links?: Array<{ label: string; url: string }>): Promise<void>;
  /**
   * Finds the first of `candidateStatusNames` (checked in order) that the
   * issue's live workflow currently offers a transition to, and performs
   * it. Every real Jira project names its own workflow statuses
   * differently ("In Review" vs "Code Review" vs "Ready for Review"), so
   * this never assumes one specific name — it asks the issue what it can
   * actually become right now and picks the first candidate that matches.
   * Returns the status name actually moved to, or null if none of the
   * candidates has an available transition (already there, or the
   * project's workflow uses an entirely different vocabulary) — this
   * never forces a transition that doesn't exist.
   */
  transitionToStatus(key: string, candidateStatusNames: string[]): Promise<string | null>;
}

export class LiveJiraIssueUpdater implements JiraIssueUpdater {
  private baseUrl: string;
  private email: string;
  private apiToken: string;

  constructor(opts?: { baseUrl?: string; email?: string; apiToken?: string }) {
    this.baseUrl = (opts?.baseUrl ?? process.env.JIRA_BASE_URL ?? '').replace(/\/$/, '');
    this.email = opts?.email ?? process.env.JIRA_EMAIL ?? '';
    this.apiToken = opts?.apiToken ?? process.env.JIRA_API_TOKEN ?? '';
    if (!this.baseUrl || !this.email || !this.apiToken) {
      throw new Error('LiveJiraIssueUpdater requires JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN');
    }
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.email}:${this.apiToken}`).toString('base64');
  }

  async addComment(key: string, text: string, links: Array<{ label: string; url: string }> = []): Promise<void> {
    const url = `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/comment`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: this.authHeader(), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: textWithLinksToAdf(text, links) }),
    });
    if (!resp.ok) throw new Error(`Jira comment write failed for ${key}: ${resp.status} ${await resp.text()}`);
  }

  async transitionToStatus(key: string, candidateStatusNames: string[]): Promise<string | null> {
    const transitionsUrl = `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`;
    const listResp = await fetch(transitionsUrl, {
      headers: { Authorization: this.authHeader(), Accept: 'application/json' },
    });
    if (!listResp.ok) {
      throw new Error(`Jira transitions lookup failed for ${key}: ${listResp.status} ${await listResp.text()}`);
    }
    const { transitions } = (await listResp.json()) as { transitions: JiraTransition[] };

    let match: JiraTransition | undefined;
    for (const candidate of candidateStatusNames) {
      match = transitions.find((t) => t.to.name.toLowerCase() === candidate.toLowerCase());
      if (match) break;
    }
    if (!match) return null;

    const doResp = await fetch(transitionsUrl, {
      method: 'POST',
      headers: { Authorization: this.authHeader(), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ transition: { id: match.id } }),
    });
    if (!doResp.ok) throw new Error(`Jira transition failed for ${key}: ${doResp.status} ${await doResp.text()}`);
    return match.to.name;
  }
}

export class MockJiraIssueUpdater implements JiraIssueUpdater {
  comments: Array<{ key: string; text: string; links: Array<{ label: string; url: string }> }> = [];
  transitionAttempts: Array<{ key: string; candidates: string[] }> = [];

  /** key -> the one status name this fake issue's workflow will report as
   * available right now, or undefined if it should offer none (matching a
   * real issue with no candidate transition available). */
  constructor(private availableStatus: Record<string, string> = {}) {}

  async addComment(key: string, text: string, links: Array<{ label: string; url: string }> = []): Promise<void> {
    this.comments.push({ key, text, links });
  }

  async transitionToStatus(key: string, candidateStatusNames: string[]): Promise<string | null> {
    this.transitionAttempts.push({ key, candidates: candidateStatusNames });
    const available = this.availableStatus[key];
    if (!available) return null;
    const matched = candidateStatusNames.find((c) => c.toLowerCase() === available.toLowerCase());
    return matched ? available : null;
  }
}
