import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { getDb } from '../db/index.js';
import { archivedTickets } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config/index.js';
import { buildConnectors } from '../integrations/factory.js';
import { runPipeline } from '../pipeline/run.js';
import { runSlackIntelligence } from '../agents/slackIntelligence/runbook.js';
import { renderDashboard } from './render.js';
import { buildLaunchCommand, buildResolveConflictCommand, isValidTicketKey, type SessionAction } from './launchSession.js';
import { LiveJiraFullDetailReader } from '../integrations/jira/issueFullDetail.js';
import { LiveJiraIssueUpdater } from '../integrations/jira/issueUpdater.js';
import { LiveJiraWorklogWriter } from '../integrations/jira/worklogWriter.js';
import { logTime } from '../agents/workLog/timeEntry.js';

const PORT = Number(process.env.DASHBOARD_PORT ?? 4180);
// Real Jira/Slack/GitHub API calls happen on this cadence — deliberately
// minutes, not seconds. The dashboard's own 60s browser refresh (see
// render.ts) just re-reads whatever this last fetched from Postgres; it was
// pointless on its own when nothing was actually re-fetching, which is
// exactly the gap this closes. 5 min balances "reasonably fresh" against
// hammering Jira Cloud/GitHub from a tab left open all day — override via
// DASHBOARD_REFRESH_MINUTES if you want it tighter or looser.
const REFRESH_MINUTES = Number(process.env.DASHBOARD_REFRESH_MINUTES ?? 5);

const db = getDb();
const config = loadConfig();
const { connectors, resolved } = buildConnectors(config, 'auto');
console.log(`Connectors: jira=${resolved.jira}, github=${resolved.github}, slack=${resolved.slack}`);

async function refresh(): Promise<void> {
  try {
    const messages = await connectors.slack.fetchRelevantMessages({ lookbackHours: 24 });
    await runSlackIntelligence(db, messages);
    await runPipeline(db, connectors, { ignoredKeys: config.jira.ignoredKeys });
    console.log(`[${new Date().toISOString()}] dashboard data refreshed`);
  } catch (err) {
    // A transient Jira/GitHub hiccup shouldn't take the dashboard down —
    // it just serves the last successfully fetched data until the next tick.
    console.error(`[${new Date().toISOString()}] refresh failed:`, err);
  }
}

// The dashboard is a local Node process on your own machine, not a hosted
// web app — this endpoint runs with normal OS-level privileges, so it can
// open a real terminal directly. It is NOT the unattended/headless agent
// path (that's blocked elsewhere by design): the button just automates
// "open a terminal, cd here, run claude" — a real, interactive session,
// identical to typing those commands by hand.
const WORK_AGENT_DIR = process.cwd();

function launchSessionForTicket(res: ServerResponse, url: URL, action: SessionAction): void {
  const key = url.searchParams.get('key') ?? '';
  if (!isValidTicketKey(key)) {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `not a valid ticket key: ${key}` }));
    return;
  }
  try {
    const { bin, args } = buildLaunchCommand(config.dashboard.terminalOs, WORK_AGENT_DIR, key, action);
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
    child.unref(); // don't keep the dashboard process alive waiting on the terminal
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(err) }));
  }
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

function launchResolveConflict(res: ServerResponse, url: URL): void {
  const repo = url.searchParams.get('repo') ?? '';
  const number = Number(url.searchParams.get('number'));
  const title = url.searchParams.get('title') ?? '';
  const branch = url.searchParams.get('branch') ?? '';
  if (!REPO_RE.test(repo) || !Number.isInteger(number) || number <= 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `not a valid PR reference: ${repo}#${number}` }));
    return;
  }
  try {
    const { bin, args } = buildResolveConflictCommand(config.dashboard.terminalOs, WORK_AGENT_DIR, { repo, number, title, branch });
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
    child.unref();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(err) }));
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
}

const MAX_BODY_BYTES = 512 * 1024; // generous for a comment/description edit; not for a file upload

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Everything below writes directly to Jira the moment the request lands —
 * no approval queue in between. That's deliberate, the same reasoning as
 * `log-time --jira` in cli.ts: a person clicking "Log time"/"Add
 * comment"/"Save" in their own dashboard, about their own ticket, IS the
 * approval — there's no one else in the loop to ask. What never happens
 * regardless: nothing here can merge a PR, deploy anything, or send a
 * Slack message — those guardrails live entirely outside this file and
 * aren't touched by adding these routes.
 */
async function handleTicketDetail(res: ServerResponse, url: URL): Promise<void> {
  const key = url.searchParams.get('key') ?? '';
  if (!isValidTicketKey(key)) return sendJson(res, 400, { error: `not a valid ticket key: ${key}` });
  try {
    const detail = await new LiveJiraFullDetailReader().fetchFullDetail(key);
    sendJson(res, 200, detail);
  } catch (err) {
    sendJson(res, 502, { error: String(err) });
  }
}

async function handleJiraAttachment(res: ServerResponse, url: URL): Promise<void> {
  const id = url.searchParams.get('id') ?? '';
  if (!/^\d+$/.test(id)) return sendJson(res, 400, { error: 'not a valid attachment id' });
  const baseUrl = (process.env.JIRA_BASE_URL ?? '').replace(/\/$/, '');
  const email = process.env.JIRA_EMAIL ?? '';
  const apiToken = process.env.JIRA_API_TOKEN ?? '';
  if (!baseUrl || !email || !apiToken) return sendJson(res, 400, { error: 'Jira is not configured (JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN)' });

  try {
    const authHeader = 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');
    const upstream = await fetch(`${baseUrl}/rest/api/3/attachment/content/${id}`, {
      headers: { Authorization: authHeader },
      redirect: 'follow',
    });
    if (!upstream.ok || !upstream.body) {
      res.writeHead(upstream.status || 502).end(`attachment fetch failed: ${upstream.status}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'Content-Disposition': upstream.headers.get('content-disposition') ?? 'attachment',
    });
    // Node's http response isn't a WHATWG WritableStream, so the upstream
    // web ReadableStream (from fetch) is drained by hand rather than piped.
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    res.writeHead(502).end(String(err));
  }
}

async function handleTicketLogTime(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const key = url.searchParams.get('key') ?? '';
  if (!isValidTicketKey(key)) return sendJson(res, 400, { error: `not a valid ticket key: ${key}` });
  try {
    const body = await readJsonBody(req);
    const minutes = Number(body.minutes);
    const comment = typeof body.comment === 'string' ? body.comment : undefined;
    if (!Number.isFinite(minutes) || minutes <= 0) return sendJson(res, 400, { error: 'minutes must be a positive number' });

    const date = new Date().toISOString().slice(0, 10);
    await new LiveJiraWorklogWriter().logWork(key, minutes, { comment, date });
    // Mirrors the local bookkeeping the CLI's own `log-time --jira` path
    // keeps — so this shows up in the dashboard's own "Today" panel too,
    // not just on the Jira issue.
    await logTime(db, { date, minutes, jiraKey: key, note: comment });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 502, { error: String(err) });
  }
}

async function handleTicketComment(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const key = url.searchParams.get('key') ?? '';
  if (!isValidTicketKey(key)) return sendJson(res, 400, { error: `not a valid ticket key: ${key}` });
  try {
    const body = await readJsonBody(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return sendJson(res, 400, { error: 'comment text is required' });
    await new LiveJiraIssueUpdater().addComment(key, text);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 502, { error: String(err) });
  }
}

async function handleTicketDescription(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const key = url.searchParams.get('key') ?? '';
  if (!isValidTicketKey(key)) return sendJson(res, 400, { error: `not a valid ticket key: ${key}` });
  try {
    const body = await readJsonBody(req);
    const text = typeof body.text === 'string' ? body.text : '';
    await new LiveJiraIssueUpdater().updateDescription(key, text);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 502, { error: String(err) });
  }
}

/**
 * A purely local "stop showing me this" flag — never writes anything to
 * Jira. See render.ts: any ticket in archived_tickets is filtered out of
 * every dashboard view (Active work items, Recently merged, pending
 * approvals) until it's unarchived, and that filter is re-applied on every
 * render, so it survives a restart/refresh rather than just hiding
 * something client-side until the next reload.
 */
async function handleArchiveTicket(res: ServerResponse, url: URL): Promise<void> {
  const key = url.searchParams.get('key') ?? '';
  const summary = url.searchParams.get('summary') ?? '';
  const ticketUrl = url.searchParams.get('url') ?? '';
  if (!isValidTicketKey(key)) return sendJson(res, 400, { error: `not a valid ticket key: ${key}` });
  try {
    await db
      .insert(archivedTickets)
      .values({ id: key, summary, url: ticketUrl, archivedAt: new Date() })
      .onConflictDoUpdate({ target: archivedTickets.id, set: { summary, url: ticketUrl, archivedAt: new Date() } });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 502, { error: String(err) });
  }
}

async function handleUnarchiveTicket(res: ServerResponse, url: URL): Promise<void> {
  const key = url.searchParams.get('key') ?? '';
  if (!isValidTicketKey(key)) return sendJson(res, 400, { error: `not a valid ticket key: ${key}` });
  try {
    await db.delete(archivedTickets).where(eq(archivedTickets.id, key));
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 502, { error: String(err) });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/start-task') {
    launchSessionForTicket(res, url, 'work');
    return;
  }

  // Read-only for now, by design — the estimate is just printed in the
  // terminal (see launchSession.ts's prompt). No approval flow, no DB
  // write, nothing on the dashboard reflects this yet; that's deliberately
  // deferred until the estimation itself is proven good.
  if (req.method === 'POST' && url.pathname === '/estimate-task') {
    launchSessionForTicket(res, url, 'estimate');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/resolve-conflict') {
    launchResolveConflict(res, url);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/ticket-detail') {
    await handleTicketDetail(res, url);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/jira-attachment') {
    await handleJiraAttachment(res, url);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/ticket-log-time') {
    await handleTicketLogTime(req, res, url);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/ticket-comment') {
    await handleTicketComment(req, res, url);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/ticket-description') {
    await handleTicketDescription(req, res, url);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/archive-ticket') {
    await handleArchiveTicket(res, url);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/unarchive-ticket') {
    await handleUnarchiveTicket(res, url);
    return;
  }

  if (url.pathname !== '/') {
    res.writeHead(404).end('not found');
    return;
  }
  try {
    const html = await renderDashboard(db);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
  } catch (err) {
    res.writeHead(500).end(String(err));
  }
});

server.listen(PORT, () => {
  console.log(`Work Agent dashboard: http://localhost:${PORT}`);
  console.log(`Refreshing real data every ${REFRESH_MINUTES} min in the background (starting now)`);
});

await refresh();
setInterval(refresh, REFRESH_MINUTES * 60_000);
