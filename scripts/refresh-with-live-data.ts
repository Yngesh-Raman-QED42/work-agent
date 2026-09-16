/**
 * Refreshes the dashboard with REAL Jira/Slack data, without needing
 * JIRA_API_TOKEN or SLACK_USER_TOKEN — because the data isn't fetched by
 * this script's own connectors. It's fetched by whoever is running this
 * (a live Claude Code session, via its own MCP tool access), staged as
 * JSON, and read in here. GitHub needs no staging since it's genuinely
 * live already (LiveGitHubConnector, via the `gh` CLI).
 *
 * Usage: a live session populates scripts/live-data/jira-issues.json and
 * scripts/live-data/slack-messages.json (arrays matching JiraIssue /
 * SlackMessage — see src/models/types.ts), then runs:
 *   npx tsx scripts/refresh-with-live-data.ts
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeDb } from '../src/db/index.js';
import { loadConfig } from '../src/config/index.js';
import { runPipeline } from '../src/pipeline/run.js';
import { runSlackIntelligence } from '../src/agents/slackIntelligence/runbook.js';
import { MockJiraConnector } from '../src/integrations/jira/mock.js';
import { MockSlackConnector } from '../src/integrations/slack/mock.js';
import { LiveGitHubConnector } from '../src/integrations/github/live.js';
import type { JiraIssue, SlackMessage } from '../src/models/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'live-data');

function loadJson<T>(filename: string): T[] {
  const path = join(DATA_DIR, filename);
  if (!existsSync(path)) {
    console.warn(`(no ${filename} staged — using empty list)`);
    return [];
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

async function main() {
  const issues = loadJson<JiraIssue>('jira-issues.json');
  const messages = loadJson<SlackMessage>('slack-messages.json');

  const config = loadConfig();
  const db = getDb();
  const result = await runPipeline(db, {
    jira: new MockJiraConnector(issues),
    slack: new MockSlackConnector(messages),
    github: new LiveGitHubConnector(config.github.approvedRepos), // this one's genuinely live already
  });
  const slackResult = await runSlackIntelligence(db, messages);

  console.log(result.briefing);
  console.log(`[work items: ${result.items.length}, approvals: ${result.approvalQueue.length}]`);
  console.log('\n--- Slack ---');
  console.log(slackResult.summary);

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
