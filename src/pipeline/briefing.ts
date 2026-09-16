import type { AnyDb } from '../db/index.js';
import { briefings } from '../db/schema.js';
import type { Category, Urgency, WorkItem } from '../models/types.js';
import { workItemLabel, workItemSummary } from '../models/types.js';
import type { StateDiff } from './state.js';

const SECTION_ORDER: Category[] = ['needs_review', 'needs_action', 'blocked', 'waiting_on_others', 'slack_mention', 'fyi'];
const SECTION_TITLES: Record<Category, string> = {
  needs_review: 'Needs your review',
  needs_action: 'Needs your action',
  blocked: 'Blocked / on hold',
  waiting_on_others: 'Waiting on others',
  slack_mention: 'Slack mentions (no linked ticket)',
  fyi: 'FYI',
};
const URGENCY_RANK: Record<Urgency, number> = { high: 0, medium: 1, low: 2 };

export function generateBriefing(items: WorkItem[], diff: StateDiff, runDate: string): string {
  const lines: string[] = [`# Morning Briefing — ${runDate}`, ''];
  lines.push(
    `Tracking **${items.length}** work items (${diff.newItems.length} new, ${diff.changed.length} changed, ${diff.resolved.length} resolved since last run).`,
  );
  lines.push('');

  const byCategory = new Map<Category, WorkItem[]>();
  for (const item of items) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }

  for (const category of SECTION_ORDER) {
    const catItems = byCategory.get(category);
    if (!catItems || catItems.length === 0) continue;
    catItems.sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]);
    lines.push(`## ${SECTION_TITLES[category]} (${catItems.length})`);
    for (const item of catItems) {
      const flags: string[] = [];
      if (diff.newItems.includes(item.id)) flags.push('NEW');
      if (diff.changed.includes(item.id)) flags.push('CHANGED');
      const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
      lines.push(`- **${workItemLabel(item)}** (${item.urgency})${flagStr} — ${workItemSummary(item)}`);
      for (const reason of item.reasons) lines.push(`  - ${reason}`);
    }
    lines.push('');
  }

  if (diff.resolved.length > 0) {
    lines.push(`## Resolved since last run (${diff.resolved.length})`);
    for (const id of diff.resolved) lines.push(`- ${id}`);
    lines.push('');
  }

  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

export async function persistBriefing(db: AnyDb, runDate: string, content: string, kind = 'daily'): Promise<void> {
  await db
    .insert(briefings)
    .values({ kind, runDate, content, createdAt: new Date() })
    .onConflictDoUpdate({ target: [briefings.kind, briefings.runDate], set: { content, createdAt: new Date() } });
}
