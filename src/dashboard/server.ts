import 'dotenv/config';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { getDb } from '../db/index.js';
import { loadConfig } from '../config/index.js';
import { buildConnectors } from '../integrations/factory.js';
import { runPipeline } from '../pipeline/run.js';
import { runSlackIntelligence } from '../agents/slackIntelligence/runbook.js';
import { renderDashboard } from './render.js';
import { buildLaunchCommand, isValidTicketKey } from './launchSession.js';

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/start-task') {
    const key = url.searchParams.get('key') ?? '';
    if (!isValidTicketKey(key)) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `not a valid ticket key: ${key}` }));
      return;
    }
    try {
      const { bin, args } = buildLaunchCommand(config.dashboard.terminalOs, WORK_AGENT_DIR, key);
      const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
      child.unref(); // don't keep the dashboard process alive waiting on the terminal
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(err) }));
    }
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
