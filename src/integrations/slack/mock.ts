import type { SlackMessage } from '../../models/types.js';
import type { SlackConnector } from '../types.js';

export function defaultFixtureMessages(): SlackMessage[] {
  return [
    {
      channel: 'C01ENG',
      channelName: '#eng-capacity-planner',
      ts: '1725870000.000100',
      user: 'U01ALICE',
      text: '@you can you double check QED42OPSIN-59 before standup? search results still look off',
      permalink: 'https://example.slack.com/archives/C01ENG/p1725870000000100',
      mentionsMe: true,
    },
    {
      channel: 'C02QA',
      channelName: '#qa-handoff',
      ts: '1725873600.000200',
      user: 'U02BOB',
      text: 'QED42OPSIN-56 export button is passing QA, moving to Ready for Release',
      permalink: 'https://example.slack.com/archives/C02QA/p1725873600000200',
      mentionsMe: false,
    },
    {
      channel: 'C01ENG',
      channelName: '#eng-capacity-planner',
      ts: '1725877200.000300',
      user: 'U03CARL',
      text: 'anyone free to review PR #42 on capacity-planner? small one',
      permalink: 'https://example.slack.com/archives/C01ENG/p1725877200000300',
      mentionsMe: false,
    },
    {
      channel: 'C03RANDOM',
      channelName: '#random',
      ts: '1725880800.000400',
      user: 'U04DAVE',
      text: 'lunch at 1pm today?',
      permalink: 'https://example.slack.com/archives/C03RANDOM/p1725880800000400',
      mentionsMe: false,
    },
  ];
}

export class MockSlackConnector implements SlackConnector {
  constructor(private messages: SlackMessage[] = defaultFixtureMessages()) {}

  async fetchRelevantMessages(): Promise<SlackMessage[]> {
    return [...this.messages];
  }
}
