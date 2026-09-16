import type { CommunicationRisk } from './models.js';

// Anything touching a commitment, a decision, a deadline, a client, conflict,
// or sensitive information is never autonomous-send-eligible, per the spec:
// "must distinguish between low-risk routine communication and messages
// involving commitments, deadlines, technical decisions, client
// communication, conflict, sensitive information, or organizational
// decisions."
const CONSEQUENTIAL_PATTERNS = [
  /\bi (will|'ll) (have|deliver|finish|ship)\b/i, // commitment
  /\bby (tomorrow|monday|tuesday|wednesday|thursday|friday|eod|end of day|next week)\b/i, // deadline
  /\bclient\b/i,
  /\bdisagree\b/i,
  /\bnot (sure|comfortable) (with|about)\b/i,
  /\bescalat/i,
  /\bconfidential\b/i,
  /\bsalary\b/i,
  /\bperformance review\b/i,
  /\bdecision\b/i,
  /\bcommit(ment)?\b/i,
];

export function classifyCommunicationRisk(text: string): { risk: CommunicationRisk; reasons: string[] } {
  for (const pattern of CONSEQUENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      return { risk: 'consequential', reasons: [`matches a consequential-communication pattern: ${pattern}`] };
    }
  }
  return { risk: 'routine', reasons: ['no commitment/deadline/decision/client/conflict/sensitive-info pattern matched'] };
}
