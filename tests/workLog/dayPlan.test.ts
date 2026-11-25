import { describe, expect, it } from 'vitest';
import {
  DAY_MAX_MINUTES,
  DAY_MIN_MINUTES,
  dayTotal,
  fromClock,
  jiraStarted,
  resolveDayPlan,
  splitByWeight,
  validateDayPlan,
  pickDayTotal,
  capProblems,
  type DayPlan,
} from '../../src/agents/workLog/dayPlan.js';

// Deterministic "random" numbers for repeatable tests.
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};
const note = (what: string) => `${what}: went through the changes, checked them locally and wrote up the follow-ups.`;

const monday: DayPlan = {
  date: '2026-11-23',
  entries: [
    { ticket: 'UNLSD-10', minutes: 30, note: note('Daily standup with the team on status and blockers') },
    { ticket: 'QGP-486', minutes: 60, note: note('JavaScript team meeting and peer calls') },
    { ticket: 'UNLSD-101', note: note('PR #27 review'), weight: 2 },
    { ticket: 'QED42OPSIN-82', note: note('Slack capacity PR work') },
  ],
};

describe('validateDayPlan', () => {
  it('accepts a normal working day', () => {
    expect(validateDayPlan(monday)).toEqual([]);
  });

  it('wants a real description, not a label', () => {
    const plan = { ...monday, entries: [{ ticket: 'UNLSD-10', minutes: 30, note: 'DSM' }] };
    expect(validateDayPlan(plan).join()).toMatch(/at least 12 words/);
  });

  it('rejects weekends, bad keys and the same description twice', () => {
    const plan: DayPlan = {
      date: '2026-11-22',
      entries: [
        { ticket: 'unlsd 10', note: note('A') },
        { ticket: 'UNLSD-11', note: note('A') },
      ],
    };
    const problems = validateDayPlan(plan).join('\n');
    expect(problems).toMatch(/weekend/);
    expect(problems).toMatch(/not a Jira key/);
    expect(problems).toMatch(/same description/);
  });
});

describe('resolveDayPlan', () => {
  it('lands every day between 7h35 and 8h25, never exactly 8h, keeping fixed entries', () => {
    const totals = new Set<number>();
    for (const r of [0, 0.13, 0.5, 0.77, 0.99]) {
      const day = resolveDayPlan(monday, [], seq(r, 0.3, 0.6, 0.9));
      const total = dayTotal(day);
      expect(total).toBeGreaterThanOrEqual(DAY_MIN_MINUTES);
      expect(total).toBeLessThanOrEqual(DAY_MAX_MINUTES);
      expect(total).not.toBe(480);
      expect(day.entries[0]!.minutes).toBe(30);
      expect(day.entries[1]!.minutes).toBe(60);
      day.entries.forEach((e) => expect(e.minutes! % 5).toBe(0));
      totals.add(total);
    }
    expect(totals.size).toBeGreaterThan(1); // varies with the random numbers
  });

  it('counts what is already in Jira and starts after it', () => {
    const day = resolveDayPlan(monday, [{ ticket: 'QGP-487', minutes: 120, start: '10:00' }], seq(0.5));
    expect(dayTotal(day, [{ ticket: 'QGP-487', minutes: 120, start: '10:00' }])).toBeLessThanOrEqual(DAY_MAX_MINUTES);
    expect(fromClock(day.entries[0]!.start!)).toBeGreaterThanOrEqual(12 * 60);
  });

  it('lays entries out one after another, without overlaps', () => {
    const day = resolveDayPlan(monday, [], seq(0.4, 0.7));
    for (let i = 1; i < day.entries.length; i++) {
      const prev = day.entries[i - 1]!;
      expect(fromClock(day.entries[i]!.start!)).toBeGreaterThanOrEqual(fromClock(prev.start!) + prev.minutes!);
    }
  });

  it('refuses a day the fixed entries already overfill', () => {
    const plan: DayPlan = { ...monday, entries: [{ ticket: 'UNLSD-10', minutes: 540, note: note('Long day') }, monday.entries[2]!] };
    expect(() => resolveDayPlan(plan, [], seq(0.5))).toThrow(/no room/);
  });

  it('refuses an all-fixed day that misses the range instead of padding it silently', () => {
    const plan: DayPlan = { ...monday, entries: [monday.entries[0]!, monday.entries[1]!] };
    expect(() => resolveDayPlan(plan, [], seq(0.5))).toThrow(/nothing flexible/);
  });
});

describe('splitByWeight', () => {
  it('adds up exactly, in 5-minute steps, roughly by weight', () => {
    const shares = splitByWeight(300, [2, 1], seq(0.5));
    expect(shares.reduce((a, b) => a + b, 0)).toBe(300);
    expect(shares[0]).toBeGreaterThan(shares[1]!);
    shares.forEach((s) => expect(s % 5).toBe(0));
  });
});

describe('jiraStarted', () => {
  it('formats the local time with the UTC offset', () => {
    expect(jiraStarted('2026-11-23', '10:15', 330)).toBe('2026-11-23T10:15:00.000+0530');
    expect(jiraStarted('2026-11-23', '09:00', -300)).toBe('2026-11-23T09:00:00.000-0500');
  });
});

describe('resolveDayPlan, after a preview', () => {
  it('works the flex entries out again on a re-preview instead of treating them as fixed', () => {
    const first = resolveDayPlan(monday, [], seq(0.5));
    const again = { ...first, resolved: undefined };
    const existing = [{ ticket: 'QDP-123', minutes: 30, start: '09:00' }];
    const second = resolveDayPlan(again, existing, seq(0.5));
    expect(dayTotal(second, existing)).toBeLessThanOrEqual(DAY_MAX_MINUTES);
    expect(second.entries[0]!.minutes).toBe(30); // a given duration stays
  });

  it('does not repeat the previous day total when it can avoid it', () => {
    const a = dayTotal(resolveDayPlan(monday, [], seq(0.5)));
    const b = dayTotal(resolveDayPlan(monday, [], seq(0.5), { previousTotal: a }));
    expect(b).not.toBe(a);
  });

  it('fits entries around worklogs already in Jira without overlapping them', () => {
    const existing = [{ ticket: 'QGP-487', minutes: 120, start: '11:00' }];
    const day = resolveDayPlan(monday, existing, seq(0.3));
    for (const e of day.entries) {
      const from = fromClock(e.start!);
      expect(from + e.minutes! <= 11 * 60 || from >= 13 * 60).toBe(true);
    }
  });
});

describe('pickDayTotal', () => {
  it('stays near 8h, never exactly 8h', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
      const total = pickDayTotal(0, () => r);
      expect(total).toBeGreaterThanOrEqual(460);
      expect(total).toBeLessThanOrEqual(500);
      expect(total).not.toBe(480);
    }
  });

  it('goes under 8h after long days in the week, and over after short ones', () => {
    const afterLong = pickDayTotal(0, () => 0.99, { week: { days: 2, minutes: 2 * 505 } });
    const afterShort = pickDayTotal(0, () => 0, { week: { days: 2, minutes: 2 * 455 } });
    expect(afterLong).toBeLessThan(480);
    expect(afterShort).toBeGreaterThan(480);
  });

  it('keeps a week of planned days averaging about 8h', () => {
    let rng = 0.1;
    const next = () => (rng = (rng * 7.3 + 0.37) % 1);
    const week = { days: 0, minutes: 0 };
    for (let i = 0; i < 5; i++) {
      const total = pickDayTotal(0, next, { week: { ...week } });
      week.days += 1;
      week.minutes += total;
    }
    expect(Math.abs(week.minutes / 5 - 480)).toBeLessThanOrEqual(10);
  });
});

describe('project day caps', () => {
  it('refuses a day where a project goes over its cap', () => {
    const plan: DayPlan = {
      ...monday,
      entries: [
        { ticket: 'UNLSD-10', minutes: 30, note: note('Daily standup with the team on status and blockers') },
        { ticket: 'UNLSD-101', minutes: 230, note: note('PR #27 review') },
        { ticket: 'QED42OPSIN-82', note: note('Slack capacity PR work') },
      ],
    };
    expect(() => resolveDayPlan(plan, [], seq(0.5), { caps: { UNLSD: 245 } })).toThrow(/UNLSD comes to 4h 20m/);
    expect(capProblems({ ...plan, entries: plan.entries.slice(0, 1) }, [{ ticket: 'UNLSD-9', minutes: 240, start: '10:00' }], { UNLSD: 245 })).toHaveLength(1);
  });

  it('accepts a day within the cap', () => {
    const plan: DayPlan = {
      ...monday,
      entries: [
        { ticket: 'UNLSD-10', minutes: 30, note: note('Daily standup with the team on status and blockers') },
        { ticket: 'UNLSD-101', minutes: 215, note: note('PR #27 review') },
        { ticket: 'QED42OPSIN-82', note: note('Slack capacity PR work') },
      ],
    };
    expect(() => resolveDayPlan(plan, [], seq(0.5), { caps: { UNLSD: 245 } })).not.toThrow();
  });
});

describe('day rules, edge cases', () => {
  it('never lands on exactly 8h, even when the week points there', () => {
    expect(pickDayTotal(480, () => 0, { week: { days: 1, minutes: 500 } })).not.toBe(480);
  });

  it('refuses a flex entry on a capped project, rather than failing at random', () => {
    expect(() => resolveDayPlan(monday, [], seq(0.5), { caps: { UNLSD: 245 } })).toThrow(/fixed minutes that fit/);
  });

  it('does not block a day that Jira already had over the cap when the plan adds nothing to it', () => {
    const plan: DayPlan = { ...monday, entries: [monday.entries[1]!] };
    expect(capProblems(plan, [{ ticket: 'UNLSD-9', minutes: 270, start: '10:00' }], { UNLSD: 245 })).toEqual([]);
  });
});

describe('exactly 8h with fixed entries', () => {
  it('refuses an all-fixed day of exactly 8h00', () => {
    const plan: DayPlan = {
      ...monday,
      entries: [
        { ticket: 'QGP-487', minutes: 240, note: note('Engineering practice meeting') },
        { ticket: 'UNLSD-101', minutes: 240, note: note('PR #27 review') },
      ],
    };
    expect(() => resolveDayPlan(plan, [], seq(0.5))).toThrow(/exactly 8h/);
  });
});
