import { and, gte, lte } from 'drizzle-orm';
import type { AnyDb } from '../../db/index.js';
import { manualTimeEntries } from '../../db/schema.js';

export interface LogTimeInput {
  date: string; // YYYY-MM-DD
  minutes: number;
  jiraKey?: string;
  note?: string;
}

/**
 * The one and only way hours enter this system: a human states them,
 * against a real day. Nothing here infers, rounds up from activity, or
 * estimates — that would be exactly the fabrication the rest of the system
 * is built to avoid. Work Log tells you WHAT happened so logging time is
 * quick to get right; it doesn't submit the number for you.
 */
export async function logTime(db: AnyDb, input: LogTimeInput): Promise<void> {
  if (input.minutes <= 0) throw new Error('minutes must be a positive number');
  await db.insert(manualTimeEntries).values({
    date: input.date,
    jiraKey: input.jiraKey ?? null,
    minutes: input.minutes,
    note: input.note ?? null,
    loggedAt: new Date(),
  });
}

export async function timeEntriesInRange(db: AnyDb, startDate: string, endDate: string) {
  return db
    .select()
    .from(manualTimeEntries)
    .where(and(gte(manualTimeEntries.date, startDate), lte(manualTimeEntries.date, endDate)))
    .orderBy(manualTimeEntries.date);
}

export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
