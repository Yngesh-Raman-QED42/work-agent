import type { SlackCategory } from './models.js';
import { CATEGORY_PRIORITY } from './classifier.js';

export interface SlackSignalRow {
  id: string;
  channel: string;
  channelName: string;
  threadTs: string | null;
  category: string;
  text: string;
  linkedJiraKey: string | null;
  createdAt: Date;
}

export interface ConversationSummary {
  channel: string;
  channelName: string;
  messageCount: number;
  topCategory: SlackCategory;
  linkedJiraKeys: string[];
  headline: string;
  mostRecentAt: Date;
  messages: SlackSignalRow[]; // available for an expandable detail — never the primary view
}

const HEADLINE_VERB: Record<SlackCategory, string> = {
  urgent: 'Urgent — needs attention now',
  task_assignment: 'Looks like a new task assignment',
  decision_required: 'Your input or a decision is needed',
  action_required: 'A specific action was requested of you',
  response_required: 'Waiting on your response',
  important_context: 'Relevant context — no direct action needed',
  informational: 'Informational',
  irrelevant: 'Low signal',
};

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function buildHeadline(channelName: string, count: number, topCategory: SlackCategory, jiraKeys: string[]): string {
  const base = `${channelName}: ${HEADLINE_VERB[topCategory]} (${pluralize(count, 'message')})`;
  return jiraKeys.length > 0 ? `${base} — mentions ${jiraKeys.join(', ')}` : base;
}

/**
 * Groups persisted Slack signals into one summary per conversation
 * (channel/DM), so the dashboard shows a conclusion ("Vidit is asking for a
 * status update, 6 messages") instead of N raw pasted lines. Raw messages
 * are still available on `messages` for anyone who wants to actually read
 * them — just not the first thing shown.
 */
export function summarizeConversations(rows: SlackSignalRow[]): ConversationSummary[] {
  const byChannel = new Map<string, SlackSignalRow[]>();
  for (const row of rows) {
    const list = byChannel.get(row.channel) ?? [];
    list.push(row);
    byChannel.set(row.channel, list);
  }

  const summaries: ConversationSummary[] = [];
  for (const [channel, messages] of byChannel) {
    messages.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const topCategory = messages.reduce<SlackCategory>((top, m) => {
      const cat = m.category as SlackCategory;
      return CATEGORY_PRIORITY[cat] < CATEGORY_PRIORITY[top] ? cat : top;
    }, messages[0]!.category as SlackCategory);
    const linkedJiraKeys = [...new Set(messages.map((m) => m.linkedJiraKey).filter((k): k is string => !!k))];

    summaries.push({
      channel,
      channelName: messages[0]!.channelName,
      messageCount: messages.length,
      topCategory,
      linkedJiraKeys,
      headline: buildHeadline(messages[0]!.channelName, messages.length, topCategory, linkedJiraKeys),
      mostRecentAt: messages[0]!.createdAt,
      messages,
    });
  }

  summaries.sort((a, b) => {
    const rankDiff = CATEGORY_PRIORITY[a.topCategory] - CATEGORY_PRIORITY[b.topCategory];
    if (rankDiff !== 0) return rankDiff;
    return b.mostRecentAt.getTime() - a.mostRecentAt.getTime();
  });

  return summaries;
}
