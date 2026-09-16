import type { AnyDb } from '../db/index.js';
import type { GitHubConnector, JiraConnector, SlackConnector } from '../integrations/types.js';
import type { WorkAgentConfig } from '../config/index.js';
import { runPipeline } from '../pipeline/run.js';
import { generateEndOfDay } from '../agents/endOfDay/runbook.js';
import { generateWeeklySummary } from '../agents/weeklySummary/runbook.js';
import { runSlackIntelligence } from '../agents/slackIntelligence/runbook.js';
import type { JobDefinition } from './scheduler.js';

export interface StandardJobsDeps {
  db: AnyDb;
  connectors: { slack: SlackConnector; jira: JiraConnector; github: GitHubConnector };
  ignoredKeys?: WorkAgentConfig['jira']['ignoredKeys'];
}

/**
 * The four standard jobs the spec asks for: morning briefing, periodic
 * PR/Slack monitoring, end-of-day, weekly summary. PR monitoring for
 * specific PRs (Phase 3's monitorPr) needs a repo+number, which only exists
 * once Engineering Execution has opened one — that's invoked from
 * execution's own follow-up, not this generic interval job; what runs here
 * on an interval is re-collecting Slack/Jira/GitHub state (the same thing
 * the morning briefing does, just more often), which is what actually
 * needs polling instead of a specific PR webhook.
 */
export function standardJobs(deps: StandardJobsDeps): JobDefinition[] {
  return [
    {
      id: 'morning_briefing',
      intervalMinutes: 24 * 60,
      run: async () => {
        await runPipeline(deps.db, deps.connectors, { ignoredKeys: deps.ignoredKeys });
      },
    },
    {
      id: 'periodic_sync',
      intervalMinutes: 30,
      run: async () => {
        const messages = await deps.connectors.slack.fetchRelevantMessages({ lookbackHours: 1 });
        await runSlackIntelligence(deps.db, messages);
        await runPipeline(deps.db, deps.connectors, { ignoredKeys: deps.ignoredKeys });
      },
    },
    {
      id: 'end_of_day',
      intervalMinutes: 24 * 60,
      run: async () => {
        await generateEndOfDay(deps.db);
      },
    },
    {
      id: 'weekly_summary',
      intervalMinutes: 7 * 24 * 60,
      run: async () => {
        await generateWeeklySummary(deps.db);
      },
    },
  ];
}
