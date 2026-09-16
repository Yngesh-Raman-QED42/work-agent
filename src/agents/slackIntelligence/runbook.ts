import type { AnyDb } from '../../db/index.js';
import { slackSignals } from '../../db/schema.js';
import { AuditLog } from '../../pipeline/audit.js';
import type { SlackMessage } from '../../models/types.js';
import { classifyAll } from './classifier.js';
import { PERSISTED_CATEGORIES, type SlackClassification } from './models.js';

export interface SlackIntelligenceResult {
  classifications: SlackClassification[];
  persisted: SlackClassification[];
  summary: string;
}

export async function runSlackIntelligence(db: AnyDb, messages: SlackMessage[]): Promise<SlackIntelligenceResult> {
  const audit = new AuditLog(db);
  await audit.log('slack_intelligence_started', { message_count: messages.length });

  const classifications = classifyAll(messages);
  const byCategory: Record<string, number> = {};
  for (const c of classifications) byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
  await audit.log('slack_intelligence_classified', { by_category: byCategory });

  const persisted = classifications.filter((c) => PERSISTED_CATEGORIES.includes(c.category));
  const now = new Date();
  for (const c of persisted) {
    const id = `${c.message.channel}:${c.message.ts}`;
    await db
      .insert(slackSignals)
      .values({
        id,
        channel: c.message.channel,
        channelName: c.message.channelName,
        threadTs: c.message.threadTs ?? null,
        category: c.category,
        text: c.message.text,
        linkedJiraKey: c.linkedJiraKey,
        createdAt: now,
      })
      .onConflictDoUpdate({ target: slackSignals.id, set: { category: c.category, linkedJiraKey: c.linkedJiraKey } });
  }
  await audit.log('slack_intelligence_persisted', { count: persisted.length });

  const summary = buildSummary(classifications);
  await audit.log('slack_intelligence_completed', {});

  return { classifications, persisted, summary };
}

function buildSummary(classifications: SlackClassification[]): string {
  const order: Array<[string, string]> = [
    ['urgent', 'Urgent'],
    ['task_assignment', 'New task assignments'],
    ['decision_required', 'Decisions needed'],
    ['action_required', 'Action requested of you'],
    ['response_required', 'Waiting on your response'],
    ['important_context', 'Important context (no direct action)'],
  ];
  const lines: string[] = [];
  for (const [category, title] of order) {
    const items = classifications.filter((c) => c.category === category);
    if (items.length === 0) continue;
    lines.push(`## ${title} (${items.length})`);
    for (const c of items) {
      const preview = c.message.text.replace(/\n/g, ' ').slice(0, 120);
      lines.push(`- [${c.message.channelName}] ${preview}`);
    }
  }
  if (lines.length === 0) return 'No Slack signal needing attention.';
  return lines.join('\n');
}
