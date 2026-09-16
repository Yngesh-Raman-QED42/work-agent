import type { SlackMessage } from '../../models/types.js';

export type SlackCategory =
  | 'irrelevant'
  | 'informational'
  | 'important_context'
  | 'response_required'
  | 'action_required'
  | 'task_assignment'
  | 'decision_required'
  | 'urgent';

export interface SlackClassification {
  message: SlackMessage;
  category: SlackCategory;
  reasons: string[];
  linkedJiraKey: string | null;
}

/** Categories worth remembering/surfacing at all. "irrelevant" and
 * "informational" are deliberately NOT persisted to slack_signals — the
 * spec asks for concise summaries, not noise storage. */
export const PERSISTED_CATEGORIES: SlackCategory[] = [
  'important_context',
  'response_required',
  'action_required',
  'task_assignment',
  'decision_required',
  'urgent',
];

export interface SlackThread {
  channel: string;
  channelName: string;
  threadTs: string;
  messages: SlackMessage[];
}
