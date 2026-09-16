import { extractJiraKeys, type SlackMessage } from '../../models/types.js';
import type { SlackCategory, SlackClassification } from './models.js';

const URGENT_PATTERNS = [/\burgent\b/i, /\basap\b/i, /\bcritical\b/i, /\bproduction (is )?down\b/i, /\bp0\b/i, /\bblocking (the )?release\b/i, /🚨/];
const ASSIGNMENT_PATTERNS = [
  /\bcan you (take|pick up|handle|own)\b/i,
  /\bassigning (this|you)\b/i,
  /\byou'?re (assigned|on the hook for)\b/i,
  /\bplease (take|pick up|handle) this\b/i,
];
const ACTION_REQUEST_PATTERNS = [/\bcan you (check|review|look at|verify|confirm|double.?check)\b/i, /\bcould you\b/i, /\bneed you to\b/i];
const DECISION_PATTERNS = [/\bwhich (one|option|approach)\b/i, /\bshould we\b/i, /\bwhat do you think\b/i, /\bthoughts\?/i, /\bdecision\b/i];
const SOCIAL_PATTERNS = [/\blunch\b/i, /\bcoffee\b/i, /\bhappy (hour|friday)\b/i, /^\s*(hi|hey|hello|gm|good morning)[\s!.]*$/i];

export function classifySlackMessage(message: SlackMessage): SlackClassification {
  const text = message.text;
  const jiraKeys = extractJiraKeys(text);
  const linkedJiraKey = jiraKeys[0] ?? null;

  if (URGENT_PATTERNS.some((p) => p.test(text))) {
    return { message, category: 'urgent', reasons: ['matches an urgency signal'], linkedJiraKey };
  }

  if (message.mentionsMe) {
    if (ASSIGNMENT_PATTERNS.some((p) => p.test(text))) {
      return { message, category: 'task_assignment', reasons: ['directly mentions you with assignment language'], linkedJiraKey };
    }
    if (DECISION_PATTERNS.some((p) => p.test(text))) {
      return { message, category: 'decision_required', reasons: ['mentions you and asks for a decision/opinion'], linkedJiraKey };
    }
    if (ACTION_REQUEST_PATTERNS.some((p) => p.test(text))) {
      return { message, category: 'action_required', reasons: ['mentions you with a specific action request'], linkedJiraKey };
    }
    if (text.trim().endsWith('?')) {
      return { message, category: 'response_required', reasons: ['mentions you and asks a direct question'], linkedJiraKey };
    }
    return { message, category: 'response_required', reasons: ['mentions you directly'], linkedJiraKey };
  }

  if (SOCIAL_PATTERNS.some((p) => p.test(text))) {
    return { message, category: 'irrelevant', reasons: ['social/off-topic chatter'], linkedJiraKey };
  }

  if (linkedJiraKey) {
    return { message, category: 'important_context', reasons: [`references ${linkedJiraKey}`], linkedJiraKey };
  }

  if (DECISION_PATTERNS.some((p) => p.test(text)) || ACTION_REQUEST_PATTERNS.some((p) => p.test(text))) {
    return { message, category: 'informational', reasons: ['relevant discussion, but not directed at you'], linkedJiraKey };
  }

  return { message, category: 'irrelevant', reasons: ['no relevance signal found'], linkedJiraKey };
}

export function classifyAll(messages: SlackMessage[]): SlackClassification[] {
  return messages.map(classifySlackMessage);
}

export const CATEGORY_PRIORITY: Record<SlackCategory, number> = {
  urgent: 0,
  task_assignment: 1,
  decision_required: 2,
  action_required: 3,
  response_required: 4,
  important_context: 5,
  informational: 6,
  irrelevant: 7,
};
