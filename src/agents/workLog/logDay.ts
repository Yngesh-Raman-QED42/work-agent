import {
  DAY_MAX_MINUTES,
  DAY_MIN_MINUTES,
  DAY_TARGET_MINUTES,
  capProblems,
  dayTotal,
  type DayPlan,
  type ExistingWorklog,
  formatDuration,
  isInJira,
  jiraStarted,
  overlapsJira,
  type PlanFile,
  resolveDayPlan,
  type Rng,
  validateDayPlan,
} from './dayPlan.js';
import type { JiraWorklogWriter, OwnWorklog } from '../../integrations/jira/worklogWriter.js';

// `work-agent log-day <plan.json>`: preview first (works out the minutes and start times and
// saves them back into the file), then `--apply` logs exactly what was previewed. Rules for what
// a day looks like live in dayPlan.ts; this file is the order of operations around them.

export interface LogDayDeps {
  /** The person's worklogs already in Jira for a date. */
  existingOn(date: string): Promise<ExistingWorklog[]>;
  writer: JiraWorklogWriter;
  /** Local record of the entry (manual_time_entries), as `log-time` keeps. */
  recordLocally(entry: { date: string; minutes: number; jiraKey: string; note: string }): Promise<void>;
  save(plan: PlanFile): Promise<void>;
  rng: Rng;
  /** This machine's UTC offset in minutes on a date (e.g. 330 for +0530), for Jira's "started". */
  utcOffsetOn(date: string): number;
  print(line: string): void;
  /** Most minutes a day per Jira project (config workLog.projectDayCaps). */
  projectDayCaps?: Record<string, number>;
}

const REPREVIEW = 'Remove "resolved" from the day and preview again.';

/** Jira "started" ("…T10:15:00.000+0530") as a local date and "HH:MM" for this machine. */
export function localParts(started: string, utcOffsetMinutes: number): { date: string; clock: string } {
  const at = new Date(started.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  const local = new Date(at.getTime() + utcOffsetMinutes * 60_000);
  return { date: local.toISOString().slice(0, 10), clock: local.toISOString().slice(11, 16) };
}

export function toExisting(worklogs: OwnWorklog[], utcOffsetMinutes: number): ExistingWorklog[] {
  return worklogs.map((w) => ({
    ticket: w.key,
    minutes: w.minutes,
    start: localParts(w.started, utcOffsetMinutes).clock,
  }));
}

/** Problems with a day as planned against what Jira has now: outside the range, or overlapping. */
function dayProblems(day: DayPlan, existing: ExistingWorklog[], caps?: Record<string, number>): string[] {
  const problems: string[] = [...capProblems(day, existing, caps)];
  const total = dayTotal(day, existing);
  if (total === DAY_TARGET_MINUTES && day.entries.some((e) => !e.logged && !isInJira(e, existing))) {
    problems.push(`${day.date} comes to exactly ${formatDuration(total)} with what's in Jira now.`);
  }
  if (total > DAY_MAX_MINUTES || total < DAY_MIN_MINUTES) {
    problems.push(
      `${day.date} comes to ${formatDuration(total)} with what's in Jira now ` +
        `(a day should be ${formatDuration(DAY_MIN_MINUTES)} to ${formatDuration(DAY_MAX_MINUTES)}).`,
    );
  }
  const clashing = day.entries
    .filter((e) => !e.logged && e.start && e.minutes !== undefined && overlapsJira(e, existing))
    .map((e) => `${e.ticket} at ${e.start}`);
  if (clashing.length) problems.push(`${day.date}: ${clashing.join(', ')} overlaps a worklog already in Jira.`);
  return problems;
}

function printDay(day: DayPlan, existing: ExistingWorklog[], print: (l: string) => void, caps?: Record<string, number>) {
  print(`\n${day.date}  total ${formatDuration(dayTotal(day, existing))}`);
  for (const w of existing) print(`  ${w.start}  ${formatDuration(w.minutes).padEnd(7)} ${w.ticket}  (already in Jira)`);
  for (const e of day.entries.filter((entry) => !entry.logged && !isInJira(entry, existing))) {
    print(`  ${e.start ?? '--:--'}  ${formatDuration(e.minutes ?? 0).padEnd(7)} ${e.ticket}`);
    print(`         ${e.note}`);
  }
  for (const problem of dayProblems(day, existing, caps)) print(`  ! ${problem} ${REPREVIEW}`);
}

/** Monday to the day before `date`, in its week (none for a Monday). */
export function earlierWeekdays(date: string): string[] {
  const day = new Date(`${date}T12:00:00Z`);
  const weekday = (day.getUTCDay() + 6) % 7; // Monday = 0
  return Array.from({ length: Math.min(weekday, 5) }, (_, i) =>
    new Date(day.getTime() - (weekday - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

/** The `count` weekdays before `date`, most recent first (across weekends). */
export function previousWeekdays(date: string, count: number): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${date}T12:00:00Z`) - 86_400_000; out.length < count; t -= 86_400_000) {
    const day = new Date(t);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) out.push(day.toISOString().slice(0, 10));
  }
  return out;
}

/** The file's shape and every day's rules; checked by both preview and apply. */
function checkFile(file: PlanFile) {
  if (!Array.isArray(file.days) || file.days.some((d) => !Array.isArray(d?.entries))) {
    throw new Error('The plan needs { "days": [{ "date": "YYYY-MM-DD", "entries": [...] }] }');
  }
  const problems = file.days.flatMap(validateDayPlan);
  const dates = file.days.map((d) => d.date);
  dates.forEach((d, i) => dates.indexOf(d) !== i && problems.push(`${d} appears twice in the plan`));
  if (problems.length) throw new Error(problems.join('\n'));
}

/** Works out every day that isn't resolved yet (in date order), saves the file, prints the days. */
export async function previewPlan(file: PlanFile, deps: LogDayDeps): Promise<PlanFile> {
  checkFile(file);

  // Totals of days worked out so far (the plan's) and read from Jira, by date.
  const totals = new Map<string, number>();
  const cache = new Map<string, ExistingWorklog[]>();
  const existingOn = async (date: string) => {
    if (!cache.has(date)) cache.set(date, await deps.existingOn(date));
    return cache.get(date)!;
  };
  const totalOn = async (date: string) =>
    totals.get(date) ?? (await existingOn(date)).reduce((sum, w) => sum + w.minutes, 0);

  const days: DayPlan[] = [];
  for (const day of [...file.days].sort((a, b) => a.date.localeCompare(b.date))) {
    const existing = await existingOn(day.date);
    // Earlier working days of the same week that have time logged (a day off isn't "owed"). Each
    // counts only by how far it drifted from 8h within a normal day's range, so a half day off
    // isn't paid back by every later day.
    const week = { days: 0, minutes: 0 };
    for (const date of earlierWeekdays(day.date)) {
      const minutes = await totalOn(date);
      if (minutes > 0) {
        week.days += 1;
        week.minutes += Math.min(DAY_MAX_MINUTES, Math.max(DAY_MIN_MINUTES, minutes));
      }
    }
    // The last working day with time logged (up to a week back, across weekends and days off).
    let previousTotal: number | undefined;
    for (const date of previousWeekdays(day.date, 7)) {
      const minutes = await totalOn(date);
      if (minutes > 0) {
        previousTotal = minutes;
        break;
      }
    }
    const context = {
      previousTotal,
      week,
      caps: deps.projectDayCaps,
    };
    const resolved = day.resolved ? day : resolveDayPlan(day, existing, deps.rng, context);
    totals.set(day.date, dayTotal(resolved, existing));
    days.push(resolved);
    printDay(resolved, existing, deps.print, deps.projectDayCaps);
  }
  const out = { days };
  await deps.save(out);
  return out;
}

/**
 * Logs what the preview worked out. Refuses a plan that wasn't previewed, and re-reads Jira first,
 * so worklogs added some other way since the preview can't push a day out of range or overlap it.
 * Each entry is marked `logged` as soon as Jira accepts it and `recorded` once the local record is
 * written, so a failed run can simply be re-run without logging anything twice.
 */
export async function applyPlan(file: PlanFile, deps: LogDayDeps): Promise<void> {
  checkFile(file);
  const unresolved = file.days.filter((d) => !d.resolved).map((d) => d.date);
  if (unresolved.length) {
    throw new Error(`Preview first (run without --apply): not worked out yet for ${unresolved.join(', ')}`);
  }
  for (const day of file.days) {
    if (day.entries.every((e) => e.logged && e.recorded)) continue;
    const incomplete = day.entries
      .filter((e) => !e.logged && (e.minutes === undefined || !e.start))
      .map((e) => e.ticket);
    if (incomplete.length) {
      throw new Error(`${day.date}: ${incomplete.join(', ')} changed since the preview (no minutes or start). ${REPREVIEW}`);
    }
    const existing = await deps.existingOn(day.date);
    // Only when something is still to be posted; finishing local records needs no re-check.
    if (day.entries.some((e) => !e.logged)) {
      const problems = dayProblems(day, existing, deps.projectDayCaps);
      if (problems.length) throw new Error(`${problems.join(' ')} Nothing logged for that day. ${REPREVIEW}`);
    }

    const offset = deps.utcOffsetOn(day.date);
    for (const entry of day.entries) {
      const minutes = entry.minutes!;
      if (!entry.logged) {
        // Already in Jira from a run that stopped before saving: mark it, don't post it twice.
        const there = isInJira(entry, existing);
        if (!there) {
          await deps.writer.logWork(entry.ticket, minutes, {
            comment: entry.note,
            started: jiraStarted(day.date, entry.start!, offset),
          });
        }
        entry.logged = true;
        await deps.save(file);
        deps.print(`${there ? 'Already in Jira' : 'Logged'} ${formatDuration(minutes)} on ${entry.ticket} (${day.date} ${entry.start}).`);
      }
      if (!entry.recorded) {
        await deps.recordLocally({ date: day.date, minutes, jiraKey: entry.ticket, note: entry.note });
        entry.recorded = true;
        await deps.save(file);
      }
    }
  }
}
