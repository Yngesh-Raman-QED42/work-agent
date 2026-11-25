// Day plans for `work-agent log-day`: the person says what they worked on (tickets, rough
// hours, or just "reviews most of the day"), and this turns it into a full, believable day of
// Jira worklogs, the same way every time, so the logging rules never have to be repeated:
//
// - every working day lands near 8h, a little over or under but never exactly 8h, and not the
//   same total as the day before (a random total between DAY_MIN and DAY_MAX, 5-minute steps);
// - over a week the days average about 8h: a day after long ones comes out shorter, and the
//   other way round (the earlier days of that Mon-Fri week, from Jira and the plan, are counted);
// - entries with a fixed duration ("2h on the team meeting") keep it; "flex" entries share what's
//   left by weight, with jitter, so no two days split the same way;
// - every entry needs a real description (MIN_NOTE_WORDS words or more), not a one-word label;
// - entries are laid out one after another through the working day (not all at 09:00), in the
//   free time around anything already logged that day, which also counts towards the total.
//
// Pure functions only (randomness is injected), so the rules are tested; the CLI does the I/O.

export const DAY_MIN_MINUTES = 7 * 60 + 35; // 7h35
export const DAY_MAX_MINUTES = 8 * 60 + 25; // 8h25
export const DAY_TARGET_MINUTES = 8 * 60; // what a week of days averages to
const SPREAD_MINUTES = 20; // how far a day may drift from where the week needs it
export const MIN_NOTE_WORDS = 12;
export const STEP_MINUTES = 5;
export const FLEX_MIN_MINUTES = 15;
export const DAY_START = '10:00';

export interface PlanEntry {
  ticket: string;
  note: string;
  /** Fixed duration. Without it the entry is "flex" and gets a share of the rest of the day. */
  minutes?: number;
  /** Flex share (default 1): an entry with weight 2 gets about twice the time of weight 1. */
  weight?: number;
  /** Set when resolving: the minutes were worked out, not given, so a re-preview may change them. */
  flex?: boolean;
  /** Set once resolved: local start time "HH:MM" (Jira "started"). */
  start?: string;
  /** Set by --apply once the worklog is in Jira, so a re-run never logs it twice. */
  logged?: boolean;
  /** Set by --apply once the local record (manual_time_entries) is written too. */
  recorded?: boolean;
}

export interface DayPlan {
  date: string; // YYYY-MM-DD
  entries: PlanEntry[];
  /** Set once the minutes and start times have been worked out (the preview). */
  resolved?: boolean;
}

export interface PlanFile {
  days: DayPlan[];
}

/** A worklog already in Jira for that day (by this person). */
export interface ExistingWorklog {
  ticket: string;
  minutes: number;
  start: string; // local "HH:MM"
}

export type Rng = () => number; // [0, 1)

const TICKET = /^[A-Z][A-Z0-9]+-\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const roundToStep = (minutes: number) => Math.round(minutes / STEP_MINUTES) * STEP_MINUTES;
const randomStep = (min: number, max: number, rng: Rng) =>
  min + STEP_MINUTES * Math.floor(rng() * (Math.floor((max - min) / STEP_MINUTES) + 1));

export const toClock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
export const fromClock = (clock: string) => {
  const [h, m] = clock.split(':').map(Number);
  return h! * 60 + m!;
};

/** Problems with a plan as written, before anything is worked out. Empty when it's fine. */
export function validateDayPlan(plan: DayPlan): string[] {
  const problems: string[] = [];
  if (!DATE.test(plan.date)) problems.push(`"${plan.date}" is not a YYYY-MM-DD date`);
  else {
    const weekday = new Date(`${plan.date}T12:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) problems.push(`${plan.date} is a weekend day`);
  }
  if (!plan.entries.length) problems.push(`${plan.date} has no entries`);
  const notes = new Set<string>();
  plan.entries.forEach((entry, i) => {
    const where = `${plan.date} entry ${i + 1} (${entry.ticket})`;
    if (!TICKET.test(entry.ticket)) problems.push(`${where}: "${entry.ticket}" is not a Jira key`);
    if (wordCount(entry.note ?? '') < MIN_NOTE_WORDS) {
      problems.push(`${where}: the description needs at least ${MIN_NOTE_WORDS} words saying what was done`);
    }
    const key = entry.note?.trim().toLowerCase();
    if (key && notes.has(key)) problems.push(`${where}: same description as another entry that day`);
    if (key) notes.add(key);
    if (entry.minutes !== undefined && (!Number.isInteger(entry.minutes) || entry.minutes <= 0)) {
      problems.push(`${where}: minutes must be a positive whole number`);
    }
    if (entry.weight !== undefined && !(entry.weight > 0)) problems.push(`${where}: weight must be above 0`);
  });
  return problems;
}

/** What the days around this one came to, for keeping the totals varied and the week near 8h. */
export interface DayContext {
  /** Total of the working day before (so this one differs). */
  previousTotal?: number;
  /** Earlier working days of the same Mon-Fri week: how many, and their total minutes. */
  week?: { days: number; minutes: number };
  /** Most minutes a day per Jira project (config workLog.projectDayCaps). */
  caps?: Record<string, number>;
}

/**
 * The day's total: random, in 5-minute steps, within DAY_MIN..DAY_MAX and not below `low`; near
 * whatever brings the week's average back to 8h; never exactly 8h or the previous day's total.
 */
export function pickDayTotal(low: number, rng: Rng, context: DayContext = {}): number {
  const { week, previousTotal } = context;
  const behind = week && week.days ? DAY_TARGET_MINUTES * week.days - week.minutes : 0;
  const ideal = Math.min(DAY_MAX_MINUTES, Math.max(DAY_MIN_MINUTES, DAY_TARGET_MINUTES + behind));
  let from = Math.max(low, roundUpToStep(ideal - SPREAD_MINUTES), DAY_MIN_MINUTES);
  let to = Math.min(DAY_MAX_MINUTES, roundToStep(ideal + SPREAD_MINUTES));
  if (from > to) [from, to] = [Math.max(low, DAY_MIN_MINUTES), DAY_MAX_MINUTES];
  const options: number[] = [];
  for (let m = from; m <= to; m += STEP_MINUTES) options.push(m);
  const avoid = (m: number) => m !== DAY_TARGET_MINUTES && m !== previousTotal;
  let pool = options.filter(avoid);
  if (!pool.length) {
    // Nothing else near where the week needs it: anywhere in the day's range rather than 8h00.
    for (let m = roundUpToStep(Math.max(low, DAY_MIN_MINUTES)); m <= DAY_MAX_MINUTES; m += STEP_MINUTES) {
      if (avoid(m)) pool.push(m);
    }
  }
  if (!pool.length) pool = options;
  return pool[Math.floor(rng() * pool.length)]!;
}

/**
 * Works out the minutes of every flex entry and the start time of every entry, so the day
 * (including what's already in Jira) lands on a random total between DAY_MIN and DAY_MAX.
 * Throws when the fixed entries alone already go past the day, or leave no room for the flex ones.
 */
export function resolveDayPlan(
  input: DayPlan,
  existing: ExistingWorklog[],
  rng: Rng,
  context: DayContext = {},
): DayPlan {
  const problems = validateDayPlan(input);
  if (problems.length) throw new Error(problems.join('\n'));

  // Entries already logged are in `existing` (they come back from Jira), including one a stopped
  // run posted without marking it; worked-out minutes from an earlier preview are worked out
  // again, so a re-preview keeps the person's own split.
  const marked = input.entries.map((e) => (!e.logged && isInJira(e, existing) ? { ...e, logged: true } : e));
  const plan: DayPlan = {
    ...input,
    entries: marked
      .filter((e) => !e.logged)
      .map((e) => (e.flex ? { ...e, minutes: undefined, start: undefined } : { ...e })),
  };
  const cappedFlex = marked
    .filter((e) => !e.logged && (e.minutes === undefined || e.flex) && context.caps?.[projectOf(e.ticket)] !== undefined)
    .map((e) => e.ticket);
  if (cappedFlex.length) {
    throw new Error(
      `${input.date}: ${cappedFlex.join(', ')} ${cappedFlex.length === 1 ? 'is' : 'are'} on a project with a daily cap, ` +
        'so give ' + (cappedFlex.length === 1 ? 'it' : 'them') + ' fixed minutes that fit and let other work be the flex.',
    );
  }
  const logged = marked.filter((e) => e.logged);
  // Everything is in Jira already: nothing left to work out (and nothing to re-check against).
  if (!plan.entries.length) return { ...input, entries: marked, resolved: true };

  const already = existing.reduce((sum, w) => sum + w.minutes, 0);
  const fixed = plan.entries.reduce((sum, e) => sum + (e.minutes ?? 0), 0);
  const flex = plan.entries.filter((e) => e.minutes === undefined);

  let entries: PlanEntry[];
  if (!flex.length) {
    const total = already + fixed;
    if (total < DAY_MIN_MINUTES || total > DAY_MAX_MINUTES) {
      throw new Error(
        `${plan.date} adds up to ${formatDuration(total)} with nothing flexible to fill it; ` +
          `a day should be ${formatDuration(DAY_MIN_MINUTES)} to ${formatDuration(DAY_MAX_MINUTES)}. ` +
          'Leave the minutes off at least one entry so it can take up the rest.',
      );
    }
    if (total === DAY_TARGET_MINUTES) {
      throw new Error(
        `${plan.date} adds up to exactly ${formatDuration(total)}. ` +
          'Leave the minutes off at least one entry so the total can vary.',
      );
    }
    if (total === context.previousTotal) {
      throw new Error(
        `${plan.date} adds up to ${formatDuration(total)}, the same as the day before. ` +
          'Leave the minutes off at least one entry so the total can vary.',
      );
    }
    entries = plan.entries.map((e) => ({ ...e }));
  } else {
    const lowest = already + fixed + flex.length * FLEX_MIN_MINUTES;
    if (lowest > DAY_MAX_MINUTES) {
      throw new Error(
        `${plan.date}: ${formatDuration(already)} already logged plus ${formatDuration(fixed)} fixed ` +
          `leaves no room for ${flex.length} flexible ${flex.length === 1 ? 'entry' : 'entries'} ` +
          `under ${formatDuration(DAY_MAX_MINUTES)}`,
      );
    }
    const target = pickDayTotal(roundUpToStep(lowest), rng, context);
    const shares = splitByWeight(target - already - fixed, flex.map((e) => e.weight ?? 1), rng);
    let next = 0;
    entries = plan.entries.map((e) =>
      e.minutes === undefined ? { ...e, minutes: shares[next++]!, flex: true } : { ...e },
    );
  }

  const overCap = capProblems({ ...plan, entries }, existing, context.caps);
  if (overCap.length) throw new Error(overCap.join('\n'));

  // One after another from the start of the day with a short random gap (a coffee, a context
  // switch), in the free time around anything already logged; never overlapping, never past midnight.
  const busy = existing.map((w) => [fromClock(w.start), fromClock(w.start) + w.minutes] as const);
  let clock = fromClock(DAY_START) + randomStep(0, 30, rng);
  for (const entry of entries) {
    for (let moved = true; moved; ) {
      moved = false;
      for (const [from, to] of busy) {
        if (clock < to && clock + entry.minutes! > from) {
          clock = to + randomStep(5, 15, rng);
          moved = true;
        }
      }
    }
    if (clock + entry.minutes! > 24 * 60) {
      throw new Error(`${plan.date}: the entries don't fit in the day around what's already logged`);
    }
    entry.start = toClock(clock);
    busy.push([clock, clock + entry.minutes!]);
    clock += entry.minutes! + randomStep(0, 10, rng);
  }
  return { ...plan, entries: [...logged, ...entries], resolved: true };
}

/** The entry, as planned, is already a worklog in Jira (same ticket, minutes and start). */
export const isInJira = (entry: PlanEntry, existing: ExistingWorklog[]) =>
  entry.start !== undefined &&
  existing.some((w) => w.ticket === entry.ticket && w.minutes === entry.minutes && w.start === entry.start);

/** The entry overlaps a worklog in Jira that isn't this entry itself. */
export const overlapsJira = (entry: PlanEntry, existing: ExistingWorklog[]) => {
  const from = fromClock(entry.start!);
  const to = from + entry.minutes!;
  return existing.some(
    (w) =>
      !(w.ticket === entry.ticket && w.minutes === entry.minutes && w.start === entry.start) &&
      from < fromClock(w.start) + w.minutes &&
      to > fromClock(w.start),
  );
};

export const projectOf = (ticket: string) => ticket.split('-')[0]!;

/**
 * Projects whose time that day (Jira plus the entries not in Jira yet) goes over its cap
 * (minutes per day, by Jira project key, e.g. { UNLSD: 245 }).
 */
export function capProblems(plan: DayPlan, existing: ExistingWorklog[], caps: Record<string, number> = {}): string[] {
  const byProject = new Map<string, number>();
  const adding = new Set<string>(); // projects the plan still adds time to
  const add = (ticket: string, minutes: number) => {
    const project = projectOf(ticket);
    byProject.set(project, (byProject.get(project) ?? 0) + minutes);
  };
  existing.forEach((w) => add(w.ticket, w.minutes));
  plan.entries
    .filter((e) => !e.logged && !isInJira(e, existing))
    .forEach((e) => {
      add(e.ticket, e.minutes ?? 0);
      adding.add(projectOf(e.ticket));
    });
  // Only when the plan adds to it: a day already over in Jira (before the cap) isn't blocked.
  return [...byProject]
    .filter(([project, minutes]) => adding.has(project) && caps[project] !== undefined && minutes > caps[project]!)
    .map(
      ([project, minutes]) =>
        `${plan.date}: ${project} comes to ${formatDuration(minutes)}, more than its ${formatDuration(caps[project]!)} a day. ` +
        `Give the ${project} entries fixed minutes that fit, and let other work take the rest.`,
    );
}

/** The day's total: what's in Jira plus the entries not in Jira yet. */
export const dayTotal = (plan: DayPlan, existing: ExistingWorklog[] = []) =>
  existing.reduce((s, w) => s + w.minutes, 0) +
  plan.entries.filter((e) => !e.logged && !isInJira(e, existing)).reduce((s, e) => s + (e.minutes ?? 0), 0);

const roundUpToStep = (minutes: number) => Math.ceil(minutes / STEP_MINUTES) * STEP_MINUTES;

/** Splits `total` minutes by weight with ±20% jitter, in 5-minute steps, each at least FLEX_MIN. */
export function splitByWeight(total: number, weights: number[], rng: Rng): number[] {
  const jittered = weights.map((w) => w * (0.8 + 0.4 * rng()));
  const sum = jittered.reduce((a, b) => a + b, 0);
  const shares = jittered.map((w) => Math.max(FLEX_MIN_MINUTES, roundToStep((total * w) / sum)));
  // Put the rounding difference on the largest share, so the total is exact.
  const diff = total - shares.reduce((a, b) => a + b, 0);
  const largest = shares.indexOf(Math.max(...shares));
  shares[largest] = shares[largest]! + diff;
  if (shares[largest]! < FLEX_MIN_MINUTES) throw new Error(`can't split ${total} minutes into ${weights.length} entries`);
  return shares;
}


export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h}h ${String(m).padStart(2, '0')}m` : `${h}h`) : `${m}m`;
}

/** Jira's "started": the local date and time with the machine's UTC offset, e.g. +0530. */
export function jiraStarted(date: string, start: string, offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
  return `${date}T${start}:00.000${offset}`;
}
