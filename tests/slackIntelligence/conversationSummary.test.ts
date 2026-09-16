import { describe, expect, it } from 'vitest';
import { summarizeConversations, type SlackSignalRow } from '../../src/agents/slackIntelligence/conversationSummary.js';

function makeRow(overrides: Partial<SlackSignalRow> = {}): SlackSignalRow {
  return {
    id: 'C1:1.0',
    channel: 'C1',
    channelName: 'DM: Someone',
    threadTs: null,
    category: 'response_required',
    text: 'hi',
    linkedJiraKey: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('summarizeConversations', () => {
  it('groups multiple messages from the same channel into one summary', () => {
    const rows = [
      makeRow({ id: '1', channel: 'C1', text: 'msg 1' }),
      makeRow({ id: '2', channel: 'C1', text: 'msg 2' }),
      makeRow({ id: '3', channel: 'C1', text: 'msg 3' }),
    ];
    const summaries = summarizeConversations(rows);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.messageCount).toBe(3);
    expect(summaries[0]!.messages).toHaveLength(3);
  });

  it('keeps different channels as separate summaries', () => {
    const rows = [makeRow({ channel: 'C1' }), makeRow({ channel: 'C2' })];
    expect(summarizeConversations(rows)).toHaveLength(2);
  });

  it('picks the highest-priority category across the conversation as topCategory', () => {
    const rows = [
      makeRow({ id: '1', category: 'informational' }),
      makeRow({ id: '2', category: 'urgent' }),
      makeRow({ id: '3', category: 'response_required' }),
    ];
    expect(summarizeConversations(rows)[0]!.topCategory).toBe('urgent');
  });

  it('deduplicates linked Jira keys across the conversation', () => {
    const rows = [
      makeRow({ id: '1', linkedJiraKey: 'ABC-1' }),
      makeRow({ id: '2', linkedJiraKey: 'ABC-1' }),
      makeRow({ id: '3', linkedJiraKey: 'ABC-2' }),
      makeRow({ id: '4', linkedJiraKey: null }),
    ];
    expect(summarizeConversations(rows)[0]!.linkedJiraKeys.sort()).toEqual(['ABC-1', 'ABC-2']);
  });

  it('produces a headline, not raw message text, as the primary summary', () => {
    const rows = [makeRow({ category: 'task_assignment', linkedJiraKey: 'PROJ-1' })];
    const headline = summarizeConversations(rows)[0]!.headline;
    expect(headline).toContain('new task assignment');
    expect(headline).toContain('PROJ-1');
    expect(headline).not.toContain('hi'); // the raw message text
  });

  it('sorts conversations by urgency, most-attention-needed first', () => {
    const rows = [
      makeRow({ id: '1', channel: 'C1', category: 'informational' }),
      makeRow({ id: '2', channel: 'C2', category: 'urgent' }),
    ];
    const summaries = summarizeConversations(rows);
    expect(summaries[0]!.channel).toBe('C2');
  });

  it('raw messages are present but not required to read the headline', () => {
    const rows = [makeRow({ text: 'the actual private message content' })];
    const summary = summarizeConversations(rows)[0]!;
    expect(summary.messages[0]!.text).toBe('the actual private message content');
    expect(summary.headline).not.toContain('the actual private message content');
  });
});
