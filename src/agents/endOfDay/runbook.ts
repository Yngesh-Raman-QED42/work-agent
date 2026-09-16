import { and, gte, lt } from 'drizzle-orm';
import type { AnyDb } from '../../db/index.js';
import { workLog } from '../../db/schema.js';
import { ApprovalsStore } from '../../shared/approvals.js';
import { persistBriefing } from '../../pipeline/briefing.js';
import { syncWorkLogFromAudit } from '../workLog/sync.js';
import { timeEntriesInRange, formatMinutes } from '../workLog/timeEntry.js';

export interface EndOfDayResult {
  runDate: string;
  content: string;
}

/** Summarizes what was ACTUALLY done today — sourced entirely from
 * work_log (itself derived only from real audit_log events) — never
 * invents completed work, open items, or hours. */
export async function generateEndOfDay(db: AnyDb, runDate: string = new Date().toISOString().slice(0, 10)): Promise<EndOfDayResult> {
  await syncWorkLogFromAudit(db);

  const dayStart = new Date(`${runDate}T00:00:00.000Z`);
  const dayEnd = new Date(`${runDate}T23:59:59.999Z`);
  const todaysEvents = await db
    .select()
    .from(workLog)
    .where(and(gte(workLog.ts, dayStart), lt(workLog.ts, dayEnd)));

  const byType = new Map<string, number>();
  for (const e of todaysEvents) byType.set(e.eventType, (byType.get(e.eventType) ?? 0) + 1);

  const pending = await new ApprovalsStore(db).listPending();
  const timeEntries = await timeEntriesInRange(db, runDate, runDate);

  const lines = [`# End of Day — ${runDate}`, ''];
  if (todaysEvents.length === 0) {
    lines.push('No work activity was logged today.');
  } else {
    lines.push(`**${todaysEvents.length}** work events logged today:`);
    for (const [type, count] of [...byType.entries()].sort()) {
      lines.push(`- ${type}: ${count}`);
    }
  }
  lines.push('');
  lines.push(`## Time logged today`);
  if (timeEntries.length === 0) {
    lines.push('None logged yet — `work-agent log-time --minutes <n> [--ticket KEY] [--note "..."]`.');
  } else {
    const totalMinutes = timeEntries.reduce((sum, e) => sum + e.minutes, 0);
    lines.push(`**${formatMinutes(totalMinutes)}** logged, from ${timeEntries.length} entr${timeEntries.length === 1 ? 'y' : 'ies'}:`);
    for (const e of timeEntries) {
      lines.push(`- ${formatMinutes(e.minutes)}${e.jiraKey ? ` — ${e.jiraKey}` : ''}${e.note ? ` — ${e.note}` : ''}`);
    }
  }
  lines.push('');
  lines.push(`## Open approvals (${pending.length})`);
  if (pending.length === 0) {
    lines.push('None — nothing waiting on you.');
  } else {
    for (const a of pending) {
      lines.push(`- [${a.riskLevel}] ${a.action} on ${a.target} — ${a.recommendedAction}`);
    }
  }

  const content = lines.join('\n') + '\n';
  await persistBriefing(db, runDate, content, 'end_of_day');
  return { runDate, content };
}
