// Deliberately NOT part of JiraConnector (src/integrations/types.ts), which
// is documented read-only and used by the observation pipeline everywhere.
// This is a separate, explicit write surface — used from exactly two
// places: an approved `log_execution_time` approval, and an ad-hoc
// `log-time --jira` request — never from anything automatic-by-default.

function plainTextToAdf(text: string): { type: 'doc'; version: 1; content: unknown[] } {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

export interface LogWorkOptions {
  comment?: string;
  // YYYY-MM-DD. Jira's worklog "started" is when the work actually
  // happened, not when the entry is created — without this, a backdated
  // request (e.g. "log this for last Friday") would silently land on
  // today instead.
  date?: string;
}

export interface JiraWorklogWriter {
  logWork(key: string, minutes: number, opts?: LogWorkOptions): Promise<void>;
}

/**
 * Writes straight to Jira's own REST v3 worklog endpoint — the same
 * endpoint op-intelligence's own "Log Work" feature calls under the hood
 * (op-intelligence's local worklog table is just an hourly-synced mirror of
 * Jira, not a separate source of truth), so a worklog written here shows up
 * there automatically, with no integration work needed on that side.
 */
export class LiveJiraWorklogWriter implements JiraWorklogWriter {
  private baseUrl: string;
  private email: string;
  private apiToken: string;

  constructor(opts?: { baseUrl?: string; email?: string; apiToken?: string }) {
    this.baseUrl = (opts?.baseUrl ?? process.env.JIRA_BASE_URL ?? '').replace(/\/$/, '');
    this.email = opts?.email ?? process.env.JIRA_EMAIL ?? '';
    this.apiToken = opts?.apiToken ?? process.env.JIRA_API_TOKEN ?? '';
    if (!this.baseUrl || !this.email || !this.apiToken) {
      throw new Error('LiveJiraWorklogWriter requires JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN');
    }
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.email}:${this.apiToken}`).toString('base64');
  }

  async logWork(key: string, minutes: number, opts?: LogWorkOptions): Promise<void> {
    if (minutes <= 0) throw new Error('minutes must be a positive number');
    const url = `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/worklog`;
    const body: Record<string, unknown> = { timeSpentSeconds: minutes * 60 };
    if (opts?.comment) body.comment = plainTextToAdf(opts.comment);
    // A fixed time-of-day is used since only a date is ever supplied — Jira
    // requires a full date-time for "started", not a bare date.
    if (opts?.date) body.started = `${opts.date}T09:00:00.000+0000`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: this.authHeader(), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Jira worklog write failed for ${key}: ${resp.status} ${await resp.text()}`);
    }
  }
}

export class MockJiraWorklogWriter implements JiraWorklogWriter {
  logged: Array<{ key: string; minutes: number; comment?: string; date?: string }> = [];

  async logWork(key: string, minutes: number, opts?: LogWorkOptions): Promise<void> {
    if (minutes <= 0) throw new Error('minutes must be a positive number');
    this.logged.push({ key, minutes, comment: opts?.comment, date: opts?.date });
  }
}
