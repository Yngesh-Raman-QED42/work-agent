import 'dotenv/config';
import { createServer } from 'node:http';
import { getDb } from '../db/index.js';
import { loadConfig } from '../config/index.js';
import { buildConnectors } from '../integrations/factory.js';
import { runPipeline } from '../pipeline/run.js';
import { runSlackIntelligence } from '../agents/slackIntelligence/runbook.js';
import { renderDashboard } from './render.js';

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

const server = createServer(async (req, res) => {
  if (req.url !== '/') {
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
