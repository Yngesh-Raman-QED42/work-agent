import type { SlackMessage } from '../../models/types.js';
import type { SlackConnector } from '../types.js';

/**
 * Read-only Slack Web API client (search.messages). Only ever calls read
 * endpoints — no chat.postMessage or similar here, deliberately.
 *
 * Requires SLACK_USER_TOKEN (an xoxp- User OAuth Token) + SLACK_USER_ID —
 * NOT a bot token. This is a correction of earlier guidance, not a
 * preference: Slack's Search API (search.messages) only works with a user
 * token — bots have no "search everything this user can see" capability,
 * and can't see a user's DMs with other people at all (a bot only sees
 * channels it's explicitly invited into). So reading your Slack activity
 * unattended structurally requires a user-level grant; there's no bot-token
 * way to do it. Create the token with ONLY read scopes (search:read.*,
 * channels:read, groups:read, im:read, mpim:read, users:read) and no
 * chat:write, so it's structurally incapable of sending anything — see
 * .env.example and README.
 *
 * The OAuth connection used inside a live Claude Code session
 * (mcp__plugin_slack_slack__*) is proxied and does not expose this token
 * directly — a separate grant is needed for a standalone process to read
 * unattended (e.g. via the scheduler). Not needed at all if you're fine
 * with Slack activity only being gathered when actively chatting with a
 * live Claude Code session (which already has read access right now).
 */
export class LiveSlackConnector implements SlackConnector {
  private token: string;
  private userId: string;

  constructor(opts?: { token?: string; userId?: string }) {
    this.token = opts?.token ?? process.env.SLACK_USER_TOKEN ?? '';
    this.userId = opts?.userId ?? process.env.SLACK_USER_ID ?? '';
    if (!this.token || !this.userId) {
      throw new Error('LiveSlackConnector requires SLACK_USER_TOKEN (a user token, not a bot token) and SLACK_USER_ID');
    }
  }

  async fetchRelevantMessages(opts: { lookbackHours: number }): Promise<SlackMessage[]> {
    const afterDate = new Date(Date.now() - opts.lookbackHours * 3600 * 1000).toISOString().slice(0, 10);
    const url = new URL('https://slack.com/api/search.messages');
    url.searchParams.set('query', `after:${afterDate}`);
    url.searchParams.set('count', '100');
    url.searchParams.set('sort', 'timestamp');

    const resp = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    const data = (await resp.json()) as {
      ok: boolean;
      error?: string;
      messages?: { matches: Array<{ channel: { id: string; name: string }; ts: string; user: string; text: string; permalink: string }> };
    };
    if (!data.ok) {
      throw new Error(`Slack search.messages failed: ${data.error}`);
    }

    return (data.messages?.matches ?? [])
      .filter((match) => match.user !== this.userId) // your own sent messages are never "signal you need to attend to"
      .map((match) => ({
        channel: match.channel.id,
        channelName: match.channel.name,
        ts: match.ts,
        user: match.user,
        text: match.text,
        permalink: match.permalink,
        mentionsMe: match.text.includes(`<@${this.userId}>`),
      }));
  }
}
