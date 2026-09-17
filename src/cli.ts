import 'dotenv/config';
import { getDb, closeDb } from './db/index.js';
import { loadConfig } from './config/index.js';
import { runPipeline } from './pipeline/run.js';
import { runSlackIntelligence } from './agents/slackIntelligence/runbook.js';
import { generateEndOfDay } from './agents/endOfDay/runbook.js';
import { generateWeeklySummary } from './agents/weeklySummary/runbook.js';
import { ApprovalsStore } from './shared/approvals.js';
import { buildConnectors, type ConnectorMode } from './integrations/factory.js';
import { logTime } from './agents/workLog/timeEntry.js';
import { LiveJiraWorklogWriter } from './integrations/jira/worklogWriter.js';
import { executeApprovedAction } from './shared/executeApproval.js';
import { LiveJiraConnector } from './integrations/jira/live.js';
import { AutonomyPolicy } from './agents/engineeringExecution/policy.js';
import { startExecution, finishExecution } from './agents/engineeringExecution/runbook.js';
import { writeExecutionState, readExecutionState } from './agents/engineeringExecution/executionState.js';
import { GitCliOps } from './agents/engineeringExecution/gitOps.js';
import { GhCliPullRequestCreator } from './agents/engineeringExecution/prOps.js';
import { PlaywrightScreenshotCapture } from './agents/engineeringExecution/screenshot.js';
import { LiveJiraIssueUpdater } from './integrations/jira/issueUpdater.js';
import { executionTasks } from './db/schema.js';
import { eq } from 'drizzle-orm';

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function cmdRun(args: string[]) {
  const mode = (flagValue(args, '--mode') ?? process.env.WORK_AGENT_MODE ?? 'auto') as ConnectorMode;
  const config = loadConfig(); // validated eagerly so config errors surface before touching the DB
  const db = getDb();
  const { connectors, resolved } = buildConnectors(config, mode);
  console.log(`[connectors: jira=${resolved.jira}, github=${resolved.github}, slack=${resolved.slack}]`);

  const result = await runPipeline(db, connectors, { ignoredKeys: config.jira.ignoredKeys });
  console.log(result.briefing);
  console.log(`[approval queue: ${result.approvalQueue.length} item(s)]`);
  console.log(`[work items tracked: ${result.items.length}]`);

  // Slack Intelligence classifies the same collected messages into the 8
  // categories and persists only the real signal (see slack_signals table /
  // dashboard) — separate from the Jira/PR-correlated work items above,
  // since a Slack message can matter without linking to any ticket at all.
  const messages = await connectors.slack.fetchRelevantMessages({ lookbackHours: 24 });
  const slackResult = await runSlackIntelligence(db, messages);
  console.log('\n--- Slack ---');
  console.log(slackResult.summary);
}

async function cmdEndOfDay() {
  const db = getDb();
  const result = await generateEndOfDay(db);
  console.log(result.content);
}

async function cmdWeeklySummary() {
  const db = getDb();
  const result = await generateWeeklySummary(db);
  console.log(result.content);
}

async function cmdApprovalsList() {
  const db = getDb();
  const pending = await new ApprovalsStore(db).listPending();
  if (pending.length === 0) {
    console.log('No pending approvals.');
    return;
  }
  for (const a of pending) {
    console.log(`\n[${a.id}] (${a.riskLevel}) ${a.action} — ${a.target}`);
    console.log(`  source: ${a.source}`);
    console.log(`  reasoning: ${a.reasoning}`);
    console.log(`  if approved: ${a.consequenceIfApproved}`);
    console.log(`  recommended: ${a.recommendedAction}`);
  }
}

async function cmdApprovalsResolve(args: string[], status: 'approved' | 'rejected') {
  const id = args[0];
  if (!id) {
    console.error(`Usage: work-agent approvals ${status === 'approved' ? 'approve' : 'reject'} <id>`);
    process.exit(1);
  }
  const db = getDb();
  const store = new ApprovalsStore(db);
  const existing = await store.get(id);
  if (!existing) {
    console.error(`No such approval: ${id}`);
    process.exit(1);
  }

  if (status === 'approved') {
    try {
      await executeApprovedAction(db, existing, { getWorklogWriter: () => new LiveJiraWorklogWriter() });
    } catch (err) {
      console.error(`Could not complete the approved action: ${err}`);
      console.error(`${id} left pending — fix the issue and approve again.`);
      process.exit(1);
    }
  }

  await store.resolve(id, status);
  console.log(`${id} marked ${status}.`);
}

async function cmdLogTime(args: string[]) {
  const minutesFlag = flagValue(args, '--minutes');
  const hoursFlag = flagValue(args, '--hours');
  const ticket = flagValue(args, '--ticket');
  const note = flagValue(args, '--note');
  const date = flagValue(args, '--date') ?? new Date().toISOString().slice(0, 10);
  const toJira = args.includes('--jira');

  const minutes = minutesFlag ? Number(minutesFlag) : hoursFlag ? Math.round(Number(hoursFlag) * 60) : NaN;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.error('Usage: work-agent log-time (--minutes <n>|--hours <n>) [--ticket KEY] [--note "..."] [--date YYYY-MM-DD] [--jira]');
    process.exit(1);
  }
  if (toJira && !ticket) {
    console.error('--jira requires --ticket <KEY> — a Jira worklog must attach to a real issue.');
    process.exit(1);
  }

  const db = getDb();
  await logTime(db, { date, minutes, jiraKey: ticket, note });
  console.log(`Logged ${minutes}m on ${date}${ticket ? ` for ${ticket}` : ''}.`);

  // Ad-hoc, explicitly requested — treated as already-approved by the
  // person asking, unlike the automatic path, which always waits in the
  // approval queue regardless of this flag.
  if (toJira && ticket) {
    try {
      await new LiveJiraWorklogWriter().logWork(ticket, minutes, { comment: note, date });
      console.log(`Also logged ${minutes}m to Jira on ${ticket}, dated ${date}.`);
    } catch (err) {
      console.error(`Local entry saved, but the Jira write failed: ${err}`);
      process.exit(1);
    }
  }
}

/**
 * The two halves of Engineering Execution, split around the one step that
 * genuinely needs a live coding agent — see CLAUDE.md. Everything on
 * either side of that step is deterministic, tested code, not something a
 * live session has to reconstruct from a prose description each time.
 */
async function cmdExecStart(args: string[]) {
  const key = args[0];
  if (!key) {
    console.error('Usage: work-agent exec-start <TICKET_KEY>');
    process.exit(1);
  }
  const config = loadConfig();
  const db = getDb();
  const jira = new LiveJiraConnector(); // throws a clear error if Jira creds aren't set — this needs real data

  const task = await jira.fetchIssueDetail(key);
  const started = await startExecution({
    db,
    config,
    candidates: [task],
    policy: new AutonomyPolicy(),
    getIssueUpdater: () => new LiveJiraIssueUpdater(),
    onProgress: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`),
  });

  if (started.status !== 'started') {
    console.error(`Not starting ${key}: ${started.reasons.join('; ')}`);
    process.exit(1);
  }

  await writeExecutionState({
    task: started.task!,
    repo: started.repo!,
    worktreePath: started.worktreePath!,
    startedAt: started.startedAt!.toISOString(),
    prompt: started.prompt!,
  });

  console.log(`Worktree ready: ${started.worktreePath}`);
  console.log(`\nImplement the ticket there now (inspect first, smallest change that satisfies it, run its own tests/lint/build as you go).`);
  console.log(`\n--- Prompt ---\n${started.prompt}\n--- end prompt ---`);
  console.log(`\nWhen done: work-agent exec-finish ${key} --summary "<what you changed and why>"`);
  console.log(`If you have to stop early: work-agent exec-finish ${key} --failed "<why>"`);
}

async function cmdExecFinish(args: string[]) {
  const key = args[0];
  if (!key) {
    console.error('Usage: work-agent exec-finish <TICKET_KEY> (--summary "..." | --failed "...")');
    process.exit(1);
  }
  const config = loadConfig();
  const db = getDb();

  const rows = await db.select().from(executionTasks).where(eq(executionTasks.id, key));
  const worktreePath = rows[0]?.worktreePath;
  if (!worktreePath) {
    console.error(`No exec-start record found for ${key} — run "work-agent exec-start ${key}" first.`);
    process.exit(1);
  }
  const state = await readExecutionState(worktreePath);
  if (!state) {
    console.error(`Execution state missing or unreadable at ${worktreePath} — run "work-agent exec-start ${key}" again.`);
    process.exit(1);
  }

  const failed = flagValue(args, '--failed');
  const summary = flagValue(args, '--summary');
  const outcome = failed ? { success: false, summary: failed } : { success: true, summary: summary ?? 'Implemented the requested change.' };

  const result = await finishExecution({
    db,
    config,
    task: state.task,
    repo: state.repo,
    worktreePath: state.worktreePath,
    startedAt: new Date(state.startedAt),
    outcome,
    gitOps: new GitCliOps(),
    prCreator: new GhCliPullRequestCreator(),
    screenshotCapture: new PlaywrightScreenshotCapture(),
    getIssueUpdater: () => new LiveJiraIssueUpdater(),
    onProgress: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`),
  });

  console.log(`Status: ${result.status}`);
  if (result.checks?.length) console.log('Checks:', result.checks.map((c) => `${c.name}=${c.passed ? 'pass' : 'FAIL'}`).join(', '));
  if (result.prUrl) console.log(`Draft/real PR: ${result.prUrl}`);
  if (result.screenshots?.length) console.log(`Screenshots: ${result.screenshots.length}${result.gifPath ? ' + GIF' : ''}`);
  if (result.screenshotError) console.log(`\nScreenshot capture failed (PR still opened without one):\n${result.screenshotError}`);
  if (result.reasons.length) console.log('Reasons:', result.reasons.join('; '));
  if (result.status === 'opened_pr') console.log('\nA log_execution_time approval is now pending — review it with "work-agent approvals list".');
}

async function cmdStatus() {
  const db = getDb();
  const pending = await new ApprovalsStore(db).listPending();
  const byRisk = new Map<string, number>();
  for (const a of pending) byRisk.set(a.riskLevel, (byRisk.get(a.riskLevel) ?? 0) + 1);
  console.log(`Pending approvals: ${pending.length}`);
  for (const [risk, count] of byRisk) console.log(`  ${risk}: ${count}`);
}

async function main() {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case 'run':
      await cmdRun(rest);
      break;
    case 'end-of-day':
      await cmdEndOfDay();
      break;
    case 'weekly-summary':
      await cmdWeeklySummary();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'log-time':
      await cmdLogTime(rest);
      break;
    case 'exec-start':
      await cmdExecStart(rest);
      break;
    case 'exec-finish':
      await cmdExecFinish(rest);
      break;
    case 'approvals': {
      const [sub, ...subRest] = rest;
      if (sub === 'list') await cmdApprovalsList();
      else if (sub === 'approve') await cmdApprovalsResolve(subRest, 'approved');
      else if (sub === 'reject') await cmdApprovalsResolve(subRest, 'rejected');
      else {
        console.error('Usage: work-agent approvals <list|approve <id>|reject <id>>');
        process.exit(1);
      }
      break;
    }
    default:
      console.error(
        'Usage: work-agent <run [--mode auto|mock|live]|end-of-day|weekly-summary|status|log-time (--minutes <n>|--hours <n>) [--ticket KEY] [--jira]|exec-start <KEY>|exec-finish <KEY> (--summary "..."|--failed "...")|approvals list|approvals approve <id>|approvals reject <id>>',
      );
      process.exit(1);
  }

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
