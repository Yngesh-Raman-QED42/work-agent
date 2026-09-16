import { sql } from 'drizzle-orm';
import type { AnyDb } from '../db/index.js';
import { workItems } from '../db/schema.js';
import type { WorkItem } from '../models/types.js';

export interface StateDiff {
  newItems: string[];
  resolved: string[];
  changed: string[];
  unchanged: string[];
}

interface PreviousRow {
  id: string;
  category: string;
  urgency: string;
}

export async function loadPrevious(db: AnyDb): Promise<Map<string, PreviousRow>> {
  const rows = await db.select({ id: workItems.id, category: workItems.category, urgency: workItems.urgency }).from(workItems);
  return new Map(rows.map((r) => [r.id, r]));
}

export function diffState(previous: Map<string, PreviousRow>, current: WorkItem[]): StateDiff {
  const currIds = new Set(current.map((i) => i.id));
  const prevIds = new Set(previous.keys());

  const newItems = [...currIds].filter((id) => !prevIds.has(id)).sort();
  const resolved = [...prevIds].filter((id) => !currIds.has(id)).sort();

  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const item of current) {
    const prev = previous.get(item.id);
    if (!prev) continue;
    if (prev.category !== item.category || prev.urgency !== item.urgency) {
      changed.push(item.id);
    } else {
      unchanged.push(item.id);
    }
  }
  changed.sort();
  unchanged.sort();

  return { newItems, resolved, changed, unchanged };
}

export async function saveCurrent(db: AnyDb, items: WorkItem[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(workItems);
    if (items.length === 0) return;
    const now = new Date();
    await tx.insert(workItems).values(
      items.map((item) => ({
        id: item.id,
        category: item.category,
        urgency: item.urgency,
        jiraKey: item.jira?.key ?? null,
        jira: item.jira,
        prs: item.prs,
        slackMessages: item.slackMessages,
        reasons: item.reasons,
        firstSeenAt: now,
        updatedAt: now,
      })),
    );
  });
}

/** Test/debug helper. */
export async function clearState(db: AnyDb): Promise<void> {
  await db.execute(sql`DELETE FROM ${workItems}`);
}
