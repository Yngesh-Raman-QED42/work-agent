// Deliberately NOT part of JiraConnector (src/integrations/types.ts), which
// is documented read-only and used by the observation pipeline everywhere.
// This is a separate, explicit write surface — used from exactly two
// places: an approved `log_execution_time` approval, and an ad-hoc
// `log-time --jira` request — never from anything automatic-by-default.

import { plainTextToAdf } from './adf.js';

export interface LogWorkOptions {
  comment?: string;
  // YYYY-MM-DD. Jira's worklog "started" is when the work actually
  // happened, not when the entry is created — without this, a backdated
  // request (e.g. "log this for last Friday") would silently land on
  // today instead.
  date?: string;
  // Full Jira date-time ("2026-11-23T10:15:00.000+0530"). Wins over `date`, so a planned day
  // (log-day) can lay its entries out through the day instead of stacking them all at 09:00.
  started?: string;
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
    if (opts?.started) body.started = opts.started;
    else if (opts?.date) body.started = `${opts.date}T09:00:00.000+0000`;

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

/** One of the person's own worklogs, read back from Jira. */
export interface OwnWorklog {
  key: string;
  minutes: number;
  started: string; // as Jira returns it, e.g. "2026-11-23T10:15:00.000+0530"
}

/**
 * Reads back the authenticated person's own worklogs for one day, so a planned day counts what's
 * already there (and never logs it twice). Read-only; kept next to the writer because it's the
 * same explicit worklog surface, not part of the observation pipeline's JiraConnector.
 */
export class LiveJiraWorklogReader {
  private baseUrl: string;
  private auth: string;

  constructor(opts?: { baseUrl?: string; email?: string; apiToken?: string }) {
    this.baseUrl = (opts?.baseUrl ?? process.env.JIRA_BASE_URL ?? '').replace(/\/$/, '');
    const email = opts?.email ?? process.env.JIRA_EMAIL ?? '';
    const apiToken = opts?.apiToken ?? process.env.JIRA_API_TOKEN ?? '';
    if (!this.baseUrl || !email || !apiToken) {
      throw new Error('LiveJiraWorklogReader requires JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN');
    }
    this.auth = 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');
  }

  private async get<T>(path: string, query: Record<string, string>): Promise<T> {
    const url = `${this.baseUrl}${path}?${new URLSearchParams(query)}`;
    const resp = await fetch(url, { headers: { Authorization: this.auth, Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`Jira read failed (${path}): ${resp.status} ${await resp.text()}`);
    return (await resp.json()) as T;
  }

  /**
   * The person's worklogs whose "started" falls on `date` (YYYY-MM-DD) by `isOnDate`. Jira's
   * worklogDate uses the profile's timezone, which may not be this machine's, so it searches a day
   * either side and lets `isOnDate` decide; worklogs are read only for that window, page by page
   * (team tickets like a daily standup have thousands).
   */
  async ownWorklogsOn(date: string, isOnDate: (started: string) => boolean): Promise<OwnWorklog[]> {
    const day = Date.parse(`${date}T00:00:00Z`);
    const around = (days: number) => new Date(day + days * 86_400_000).toISOString().slice(0, 10);
    const { accountId } = await this.get<{ accountId: string }>('/rest/api/3/myself', {});
    const issues: { key: string }[] = [];
    for (let token: string | undefined, first = true; first || token; first = false) {
      const page = await this.get<{ issues: { key: string }[]; nextPageToken?: string; isLast?: boolean }>(
        '/rest/api/3/search/jql',
        {
          jql: `worklogAuthor = currentUser() AND worklogDate >= "${around(-1)}" AND worklogDate <= "${around(1)}"`,
          fields: 'summary',
          maxResults: '100',
          ...(token ? { nextPageToken: token } : {}),
        },
      );
      issues.push(...page.issues);
      token = page.isLast === false || (page.isLast === undefined && page.nextPageToken) ? page.nextPageToken : undefined;
    }
    const out: OwnWorklog[] = [];
    for (const { key } of issues) {
      for (let startAt = 0; ; ) {
        const page = await this.get<{
          total: number;
          worklogs: { author: { accountId: string }; started: string; timeSpentSeconds: number }[];
        }>(`/rest/api/3/issue/${encodeURIComponent(key)}/worklog`, {
          startAt: String(startAt),
          maxResults: '1000',
          startedAfter: String(day - 2 * 86_400_000),
          startedBefore: String(day + 3 * 86_400_000),
        });
        for (const w of page.worklogs) {
          if (w.author.accountId === accountId && isOnDate(w.started)) {
            out.push({ key, minutes: Math.round(w.timeSpentSeconds / 60), started: w.started });
          }
        }
        startAt += page.worklogs.length;
        if (!page.worklogs.length || startAt >= page.total) break;
      }
    }
    return out;
  }
}

export class MockJiraWorklogWriter implements JiraWorklogWriter {
  logged: Array<{ key: string; minutes: number; comment?: string; date?: string; started?: string }> = [];

  async logWork(key: string, minutes: number, opts?: LogWorkOptions): Promise<void> {
    if (minutes <= 0) throw new Error('minutes must be a positive number');
    this.logged.push({ key, minutes, comment: opts?.comment, date: opts?.date, started: opts?.started });
  }
}
