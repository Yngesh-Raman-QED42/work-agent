import type { SlackMessage } from '../../models/types.js';
import type { SlackThread } from './models.js';

/** Groups messages into threads so the classifier (and any human reading a
 * summary) sees a conversation, not isolated lines. A message with no
 * thread_ts is its own single-message thread. */
export function groupIntoThreads(messages: SlackMessage[]): SlackThread[] {
  const byKey = new Map<string, SlackThread>();
  const order: string[] = [];

  for (const msg of messages) {
    const threadTs = msg.threadTs ?? msg.ts;
    const key = `${msg.channel}:${threadTs}`;
    let thread = byKey.get(key);
    if (!thread) {
      thread = { channel: msg.channel, channelName: msg.channelName, threadTs, messages: [] };
      byKey.set(key, thread);
      order.push(key);
    }
    thread.messages.push(msg);
  }

  for (const thread of byKey.values()) {
    thread.messages.sort((a, b) => Number(a.ts) - Number(b.ts));
  }

  return order.map((key) => byKey.get(key)!);
}
