import 'dotenv/config';
import { getDb, closeDb } from '../db/index.js';
import { loadConfig } from '../config/index.js';
import { Scheduler } from './scheduler.js';
import { standardJobs } from './jobs.js';
import { buildConnectors } from '../integrations/factory.js';

/**
 * NOT started automatically by anything in this codebase. Run explicitly
 * with `npm run scheduler` when you actually want a long-lived process
 * ticking every minute. Restart-safe: due-ness is read from Postgres each
 * tick, so stopping and restarting this process loses nothing.
 */
async function main() {
  const config = loadConfig();
  const db = getDb();
  const { connectors, resolved } = buildConnectors(config, 'auto');
  console.log(`Connectors: jira=${resolved.jira}, github=${resolved.github}, slack=${resolved.slack}`);

  const scheduler = new Scheduler(db, standardJobs({ db, connectors, ignoredKeys: config.jira.ignoredKeys }));
  await scheduler.ensureRegistered();

  console.log('Scheduler running. Ticking every 60s. Ctrl+C to stop.');
  const tick = async () => {
    const ran = await scheduler.tick();
    if (ran.length > 0) console.log(`[${new Date().toISOString()}] ran: ${ran.join(', ')}`);
  };

  await tick();
  const interval = setInterval(tick, 60_000);

  process.on('SIGINT', async () => {
    clearInterval(interval);
    await closeDb();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
