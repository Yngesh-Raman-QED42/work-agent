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
  it('lands every day between 8h05 and 8h55, never exactly 8h, keeping fixed entries', () => {
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
    const b = dayTotal(resolveDayPlan(monday, [], seq(0.5), a));
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
