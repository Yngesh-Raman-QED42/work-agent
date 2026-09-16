import { describe, expect, it, vi, afterEach } from 'vitest';
import { LiveSlackConnector } from '../../../src/integrations/slack/live.js';

const ME = 'U03BZD4FX38';

function mockSearchResponse(matches: Array<{ user: string; text: string; ts: string }>) {
  return {
    ok: true,
    json: async () => ({
      ok: true,
      messages: {
        matches: matches.map((m) => ({
          channel: { id: 'C1', name: '#eng' },
          ts: m.ts,
          user: m.user,
          text: m.text,
          permalink: 'http://x',
        })),
      },
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LiveSlackConnector', () => {
  it('filters out messages authored by the current user themselves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockSearchResponse([
          { user: ME, ts: '1.0', text: 'my own outgoing message' },
          { user: 'U_OTHER', ts: '2.0', text: 'a message from someone else' },
        ]),
      ),
    );

    const connector = new LiveSlackConnector({ token: 'xoxp-fake', userId: ME });
    const messages = await connector.fetchRelevantMessages({ lookbackHours: 24 });

    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe('a message from someone else');
  });

  it('throws a clear error without a token/userId rather than silently no-op', () => {
    expect(() => new LiveSlackConnector({ token: '', userId: '' })).toThrow(/SLACK_USER_TOKEN/);
  });
});
