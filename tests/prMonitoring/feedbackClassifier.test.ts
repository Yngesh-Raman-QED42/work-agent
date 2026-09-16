import { describe, expect, it } from 'vitest';
import { classifyFeedback } from '../../src/agents/prMonitoring/feedbackClassifier.js';
import type { ReviewComment } from '../../src/agents/prMonitoring/models.js';

function makeComment(body: string): ReviewComment {
  return { id: '1', author: 'reviewer', body, url: 'http://x', resolved: false };
}

describe('classifyFeedback', () => {
  it('a typo fix request is straightforward', () => {
    expect(classifyFeedback(makeComment('typo: should be "allocation" not "alocation"')).verdict).toBe('straightforward');
  });

  it('a rename request is straightforward', () => {
    expect(classifyFeedback(makeComment('can you rename this variable to something clearer?')).verdict).toBe('straightforward');
  });

  it('a request to add a test is straightforward', () => {
    expect(classifyFeedback(makeComment('please add a test for the empty-input case')).verdict).toBe('straightforward');
  });

  it('a request to update docs is straightforward', () => {
    expect(classifyFeedback(makeComment('update the README to mention this flag')).verdict).toBe('straightforward');
  });

  it('an architectural question escalates', () => {
    expect(classifyFeedback(makeComment('why did you architect this as a separate service?')).verdict).toBe('escalate');
  });

  it('a security concern escalates even if phrased casually', () => {
    expect(classifyFeedback(makeComment('quick rename here — also, security: this endpoint has no auth check')).verdict).toBe('escalate');
  });

  it('a scope question escalates', () => {
    expect(classifyFeedback(makeComment("I don't think this is in scope for this ticket")).verdict).toBe('escalate');
  });

  it('an unrecognized comment defaults to escalate, not straightforward', () => {
    const result = classifyFeedback(makeComment('hmm, interesting approach'));
    expect(result.verdict).toBe('escalate');
    expect(result.reasons[0]).toContain('no recognized straightforward-fix pattern');
  });
});
