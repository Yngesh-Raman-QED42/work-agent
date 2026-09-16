import type { FeedbackClassification, ReviewComment } from './models.js';

// Matches the spec's own examples: "adding tests, fixing a clear bug,
// renaming or extracting code, correcting a typing issue, or updating
// documentation" -> may be auto-implemented if unambiguous.
const STRAIGHTFORWARD_PATTERNS = [
  /\btypo\b/i,
  /\brename\b/i,
  /\bextract (this|it|that) into\b/i,
  /\badd (a )?test/i,
  /\bmissing (semicolon|import|export|return)\b/i,
  /\bunused (import|variable|var)\b/i,
  /\b(fix|correct) (the )?typ(e|ing)\b/i,
  /\badd (a )?(comment|jsdoc|docstring)\b/i,
  /\bupdate (the )?(docs?|documentation|readme)\b/i,
  /\bcan you (rename|extract|add a test|fix the typo)\b/i,
];

// Anything matching these forces escalation even if a straightforward
// pattern also matched — these categories always need human judgment per
// the spec ("architectural disagreement, product decision, scope change,
// security concern, or ambiguous instruction").
const ESCALATE_PATTERNS = [
  /\barchitect/i,
  /\bwhy (did|does|would) (you|this)\b/i,
  /\binstead of\b/i,
  /\blet'?s discuss\b/i,
  /\bsecurity\b/i,
  /\bshould (we|this) (really|actually)\b/i,
  /\bnot sure (this|that) is the right\b/i,
  /\bscope\b/i,
  /\bbreaking change\b/i,
  /\bdesign decision\b/i,
  /\bproduct (decision|call)\b/i,
];

export function classifyFeedback(comment: ReviewComment): FeedbackClassification {
  const text = comment.body;

  for (const pattern of ESCALATE_PATTERNS) {
    if (pattern.test(text)) {
      return { comment, verdict: 'escalate', reasons: [`matches an escalation pattern: ${pattern}`] };
    }
  }

  for (const pattern of STRAIGHTFORWARD_PATTERNS) {
    if (pattern.test(text)) {
      return { comment, verdict: 'straightforward', reasons: [`matches a known straightforward-fix pattern: ${pattern}`] };
    }
  }

  return { comment, verdict: 'escalate', reasons: ['no recognized straightforward-fix pattern matched; treating as ambiguous by default'] };
}

export function classifyAll(comments: ReviewComment[]): FeedbackClassification[] {
  return comments.filter((c) => !c.resolved).map(classifyFeedback);
}
