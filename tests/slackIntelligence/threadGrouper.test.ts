import { describe, expect, it } from 'vitest';
import { groupIntoThreads } from '../../src/agents/slackIntelligence/threadGrouper.js';
import type { SlackMessage } from '../../src/models/types.js';

function makeMsg(ts: string, overrides: Partial<SlackMessage> = {}): SlackMessage {
  return { channel: 'C1', channelName: '#c', ts, user: 'U1', text: 'hi', permalink: 'x', mentionsMe: false, ...overrides };
}

describe('groupIntoThreads', () => {
  it('groups messages sharing a thread_ts', () => {
    const messages = [makeMsg('2.0', { threadTs: '1.0' }), makeMsg('1.0', { threadTs: '1.0' })];
    const threads = groupIntoThreads(messages);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.messages.map((m) => m.ts)).toEqual(['1.0', '2.0']); // sorted
  });

  it('treats a message with no thread_ts as its own thread', () => {
    const threads = groupIntoThreads([makeMsg('1.0'), makeMsg('2.0')]);
    expect(threads).toHaveLength(2);
  });

  it('keeps different channels separate even with the same thread_ts', () => {
    const messages = [makeMsg('1.0', { channel: 'A', threadTs: '1.0' }), makeMsg('1.0', { channel: 'B', threadTs: '1.0' })];
    expect(groupIntoThreads(messages)).toHaveLength(2);
  });
});
