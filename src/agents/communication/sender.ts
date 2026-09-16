/** The only write-capable Slack interface in this codebase. Everything
 * upstream of this (drafting, risk classification) is designed so a call
 * here only ever happens after either (a) explicit human approval via the
 * approval queue, or (b) autonomy explicitly enabled for routine messages
 * via config.communication.autoSendRoutine — never by default. */
export interface SlackSender {
  sendMessage(channel: string, threadTs: string | null | undefined, text: string): Promise<string>; // returns permalink or message ts
}

/** Requires SLACK_BOT_TOKEN — deliberately a DIFFERENT, narrower credential
 * than LiveSlackConnector's SLACK_USER_TOKEN: sending only needs a bot
 * scoped to chat:write and nothing else, so even if this is ever
 * configured, that token structurally cannot read your DMs or search
 * anything — it can only post to channels it's invited into. Not needed at
 * all unless you decide to enable communication auto-send later
 * (config.communication.autoSendRoutine, off by default, and even then
 * only for routine-risk drafts — see runbook.ts). */
export class LiveSlackSender implements SlackSender {
  private token: string;

  constructor(opts?: { token?: string }) {
    this.token = opts?.token ?? process.env.SLACK_BOT_TOKEN ?? '';
    if (!this.token) throw new Error('LiveSlackSender requires SLACK_BOT_TOKEN');
  }

  async sendMessage(channel: string, threadTs: string | null | undefined, text: string): Promise<string> {
    const resp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, thread_ts: threadTs ?? undefined, text }),
    });
    const data = (await resp.json()) as { ok: boolean; error?: string; ts?: string };
    if (!data.ok) throw new Error(`Slack chat.postMessage failed: ${data.error}`);
    return data.ts ?? '';
  }
}

export class MockSlackSender implements SlackSender {
  calls: Array<{ channel: string; threadTs: string | null | undefined; text: string }> = [];

  async sendMessage(channel: string, threadTs: string | null | undefined, text: string): Promise<string> {
    this.calls.push({ channel, threadTs, text });
    return `mock-ts-${this.calls.length}`;
  }
}
