import { describe, expect, it } from 'vitest';
import { classifySlackMessage } from '../../src/agents/slackIntelligence/classifier.js';
import type { SlackMessage } from '../../src/models/types.js';

function makeMsg(text: string, mentionsMe = false): SlackMessage {
  return { channel: 'C1', channelName: '#c', ts: '1.0', user: 'U1', text, permalink: 'http://x', mentionsMe };
}

describe('classifySlackMessage', () => {
  it('urgency keywords -> urgent', () => {
    expect(classifySlackMessage(makeMsg('production is down, need help ASAP')).category).toBe('urgent');
  });

  it('mention + assignment language -> task_assignment', () => {
    expect(classifySlackMessage(makeMsg('@you can you take this one on?', true)).category).toBe('task_assignment');
  });

  it('mention + decision language -> decision_required', () => {
    expect(classifySlackMessage(makeMsg('@you which approach should we go with here?', true)).category).toBe('decision_required');
  });

  it('mention + specific action request -> action_required', () => {
    expect(classifySlackMessage(makeMsg('@you can you check this PR?', true)).category).toBe('action_required');
  });

  it('mention + plain question -> response_required', () => {
    expect(classifySlackMessage(makeMsg('@you are you around today?', true)).category).toBe('response_required');
  });

  it('social chatter with no mention -> irrelevant', () => {
    expect(classifySlackMessage(makeMsg('lunch at 1pm?')).category).toBe('irrelevant');
  });

  it('references a Jira ticket without mentioning you -> important_context', () => {
    expect(classifySlackMessage(makeMsg('QED42OPSIN-59 is now in QA')).category).toBe('important_context');
  });

  it('unrelated chatter with no signal -> irrelevant', () => {
    expect(classifySlackMessage(makeMsg('anyone seen the new office plant')).category).toBe('irrelevant');
  });

  it('extracts a linked Jira key when present', () => {
    expect(classifySlackMessage(makeMsg('any update on QED42OPSIN-59?')).linkedJiraKey).toBe('QED42OPSIN-59');
  });
});
