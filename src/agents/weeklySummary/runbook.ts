import { gte } from 'drizzle-orm';
import type { AnyDb } from '../../db/index.js';
import { workLog } from '../../db/schema.js';
import { persistBriefing } from '../../pipeline/briefing.js';
import { syncWorkLogFromAudit } from '../workLog/sync.js';
import { timeEntriesInRange, formatMinutes } from '../workLog/timeEntry.js';

export interface WeeklySummaryResult {
  weekOf: string;
  content: string;
}

/**
 * Aggregates real work_log activity from the last 7 days for timesheet
 * prep, plus whatever real hours you logged with `log-time` in that window.
 * Activity is always automatic (derived from the audit trail); hours are
 * always manual (see workLog/timeEntry.ts) — this function never converts
 * one into the other, since inferring duration from activity would be
 * exactly the fabrication the rest of the system exists to avoid.
 *
 * Known limitation, stated rather than papered over: most audit events
 * don't currently carry a Jira key/project tag (only task selection does),
 * so activity can't yet group by ticket/project as finely as logged time
 * can — that needs richer event tagging across the other agents.
 */
export async function generateWeeklySummary(db: AnyDb, weekOf: string = new Date().toISOString().slice(0, 10)): Promise<WeeklySummaryResult> {
  await syncWorkLogFromAudit(db);

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const events = await db.select().from(workLog).where(gte(workLog.ts, sevenDaysAgo));

  const byType = new Map<string, number>();
  for (const e of events) byType.set(e.eventType, (byType.get(e.eventType) ?? 0) + 1);

  const taskKeys = new Set<string>();
  for (const e of events) {
    const details = e.details as Record<string, unknown>;
    if (typeof details?.key === 'string') taskKeys.add(details.key);
  }

  const startDate = sevenDaysAgo.toISOString().slice(0, 10);
  const endDate = new Date().toISOString().slice(0, 10);
  const timeEntries = await timeEntriesInRange(db, startDate, endDate);

  const lines = [`# Weekly Summary — week of ${weekOf}`, ''];

  lines.push(`## Time logged this week`);
  if (timeEntries.length === 0) {
    lines.push(
      'No hours logged this week. Nothing here is inferred from activity — log real time with `work-agent log-time --minutes <n> [--ticket KEY]` and it shows up here.',
    );
  } else {
    const totalMinutes = timeEntries.reduce((sum, e) => sum + e.minutes, 0);
    const byTicket = new Map<string, number>();
    for (const e of timeEntries) {
      const label = e.jiraKey ?? '(unassigned)';
      byTicket.set(label, (byTicket.get(label) ?? 0) + e.minutes);
    }
    lines.push(`**${formatMinutes(totalMinutes)}** logged across ${timeEntries.length} entr${timeEntries.length === 1 ? 'y' : 'ies'} — this is what goes on your timesheet:`);
    for (const [ticket, minutes] of [...byTicket.entries()].sort()) {
      lines.push(`- ${ticket}: ${formatMinutes(minutes)}`);
    }
  }
  lines.push('');

  lines.push(`## Automatic activity in the last 7 days (${events.length} events)`);
  lines.push('For context on WHAT happened — not a time measurement.');
  for (const [type, count] of [...byType.entries()].sort()) {
    lines.push(`- ${type}: ${count}`);
  }
  lines.push('');
  lines.push(`## Tickets with tracked activity (${taskKeys.size})`);
  if (taskKeys.size === 0) {
    lines.push('None this week.');
  } else {
    for (const key of [...taskKeys].sort()) lines.push(`- ${key}`);
  }

  const content = lines.join('\n') + '\n';
  await persistBriefing(db, weekOf, content, 'weekly');
  return { weekOf, content };
}
