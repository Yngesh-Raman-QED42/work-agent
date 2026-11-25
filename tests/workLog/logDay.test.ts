import { describe, expect, it } from 'vitest';
import { applyPlan, earlierWeekdays, localParts, previousWeekdays, previewPlan, type LogDayDeps } from '../../src/agents/workLog/logDay.js';
import type { ExistingWorklog, PlanFile } from '../../src/agents/workLog/dayPlan.js';
import { MockJiraWorklogWriter } from '../../src/integrations/jira/worklogWriter.js';

const note = (what: string) => `${what}: went through the changes, checked them locally and wrote up the follow-ups.`;
const plan = (): PlanFile => ({
  days: [
    {
      date: '2026-11-24',
      entries: [
        { ticket: 'QGP-487', minutes: 120, note: note('Engineering practice meeting') },
        { ticket: 'UNLSD-103', note: note('PR #29 review') },
      ],
    },
  ],
});

function deps(existing: ExistingWorklog[] = []) {
  const saved: PlanFile[] = [];
  const local: unknown[] = [];
  const writer = new MockJiraWorklogWriter();
  const d: LogDayDeps = {
    existingOn: async () => existing,
    writer,
    recordLocally: async (e) => void local.push(e),
    save: async (p) => void saved.push(JSON.parse(JSON.stringify(p))),
    rng: () => 0.5,
    utcOffsetOn: () => 330,
    print: () => {},
  };
  return { d, saved, local, writer };
}

describe('log-day', () => {
  it('previews without logging, and saves the worked-out plan', async () => {
    const { d, saved, writer } = deps();
    const out = await previewPlan(plan(), d);
    expect(writer.logged).toEqual([]);
    expect(out.days[0]!.resolved).toBe(true);
    expect(out.days[0]!.entries[1]!.minutes).toBeGreaterThan(0);
    expect(saved).toHaveLength(1);
  });

  it('refuses to apply a plan that was not previewed', async () => {
    const { d, writer } = deps();
    await expect(applyPlan(plan(), d)).rejects.toThrow(/Preview first/);
    expect(writer.logged).toEqual([]);
  });

  it('logs exactly the preview, with local start times, and marks each entry logged', async () => {
    const { d, writer, local } = deps();
    const previewed = await previewPlan(plan(), d);
    await applyPlan(previewed, d);
    const day = previewed.days[0]!;
    expect(writer.logged.map((l) => [l.key, l.minutes])).toEqual(day.entries.map((e) => [e.ticket, e.minutes]));
    expect(writer.logged[0]!.started).toBe(`2026-11-24T${day.entries[0]!.start}:00.000+0530`);
    expect(day.entries.every((e) => e.logged)).toBe(true);
    expect(local).toHaveLength(2);

    // A re-run logs nothing twice.
    await applyPlan(previewed, d);
    expect(writer.logged).toHaveLength(2);
  });

  it('stops a day that something else has filled since the preview', async () => {
    const previewed = await previewPlan(plan(), deps().d);
    const { d, writer } = deps([{ ticket: 'QGP-486', minutes: 300, start: '09:00' }]);
    await expect(applyPlan(previewed, d)).rejects.toThrow(/comes to 13h/);
    expect(writer.logged).toEqual([]);
  });
});

describe('log-day safety', () => {
  it('refuses an entry added after the preview instead of logging it without minutes', async () => {
    const previewed = await previewPlan(plan(), deps().d);
    previewed.days[0]!.entries.push({ ticket: 'QDP-123', note: note('Fun Friday activity call') });
    const { d, writer } = deps();
    await expect(applyPlan(previewed, d)).rejects.toThrow(/changed since the preview/);
    expect(writer.logged).toEqual([]);
  });

  it('does not log an entry again when it is already in Jira from a run that stopped', async () => {
    const previewed = await previewPlan(plan(), deps().d);
    const first = previewed.days[0]!.entries[0]!;
    const { d, writer } = deps([{ ticket: first.ticket, minutes: first.minutes!, start: first.start! }]);
    await applyPlan(previewed, d);
    expect(writer.logged.map((l) => l.key)).toEqual(['UNLSD-103']);
    expect(previewed.days[0]!.entries.every((e) => e.logged)).toBe(true);
  });
});

describe('localParts', () => {
  it('reads a Jira start time as this machine’s local date and clock', () => {
    expect(localParts('2026-11-23T14:30:00.000+0530', 330)).toEqual({ date: '2026-11-23', clock: '14:30' });
    expect(localParts('2026-11-23T09:00:00.000+0000', 330)).toEqual({ date: '2026-11-23', clock: '14:30' });
    expect(localParts('2026-11-23T20:00:00.000+0000', 330)).toEqual({ date: '2026-11-24', clock: '01:30' });
  });
});

describe('log-day after a stopped run', () => {
  it('writes the local record for an entry that reached Jira but not the local store', async () => {
    const previewed = await previewPlan(plan(), deps().d);
    const first = previewed.days[0]!.entries[0]!;
    first.logged = true; // posted to Jira, local record never written
    const { d, writer, local } = deps([{ ticket: first.ticket, minutes: first.minutes!, start: first.start! }]);
    await applyPlan(previewed, d);
    expect(writer.logged.map((l) => l.key)).toEqual(['UNLSD-103']);
    expect(local).toHaveLength(2);
    expect(previewed.days[0]!.entries.every((e) => e.recorded)).toBe(true);
  });

  it('refuses to post an entry over a worklog added in Jira since the preview', async () => {
    const previewed = await previewPlan(plan(), deps().d);
    const second = previewed.days[0]!.entries[1]!;
    const { d, writer } = deps([{ ticket: 'QDP-123', minutes: 5, start: second.start! }]);
    await expect(applyPlan(previewed, d)).rejects.toThrow(/overlaps a worklog/);
    expect(writer.logged).toEqual([]);
  });

  it('treats an unmarked entry that is already in Jira as logged when previewing again', async () => {
    const previewed = await previewPlan(plan(), deps().d);
    const first = previewed.days[0]!.entries[0]!;
    const existing = [{ ticket: first.ticket, minutes: first.minutes!, start: first.start! }];
    const again = await previewPlan({ days: [{ ...previewed.days[0]!, resolved: undefined }] }, deps(existing).d);
    const day = again.days[0]!;
    expect(day.entries.find((e) => e.ticket === first.ticket)!.logged).toBe(true);
    expect(day.entries.filter((e) => !e.logged).map((e) => e.ticket)).toEqual(['UNLSD-103']);
  });
});

describe('earlierWeekdays', () => {
  it('lists Monday up to the day before, within the week', () => {
    expect(earlierWeekdays('2026-11-23')).toEqual([]);
    expect(earlierWeekdays('2026-11-25')).toEqual(['2026-11-23', '2026-11-24']);
    expect(earlierWeekdays('2026-11-27')).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26']);
  });
});

describe('previousWeekdays', () => {
  it('goes back across the weekend', () => {
    expect(previousWeekdays('2026-11-23', 2)).toEqual(['2026-11-20', '2026-11-19']);
  });
});
