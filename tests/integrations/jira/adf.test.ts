import { describe, expect, it } from 'vitest';
import { plainTextToAdf, textWithLinksToAdf } from '../../../src/integrations/jira/adf.js';

describe('adf builders', () => {
  it('plainTextToAdf wraps text in a single paragraph', () => {
    expect(plainTextToAdf('hello')).toEqual({
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    });
  });

  it('textWithLinksToAdf renders each link as its own paragraph with a real link mark, not bare text', () => {
    const doc = textWithLinksToAdf('did the thing', [{ label: 'PR: fix the thing', url: 'https://github.com/org/repo/pull/1' }]);
    expect(doc.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'did the thing' }] },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'PR: fix the thing',
            marks: [{ type: 'link', attrs: { href: 'https://github.com/org/repo/pull/1' } }],
          },
        ],
      },
    ]);
  });

  it('textWithLinksToAdf with no links is just the text paragraph', () => {
    const doc = textWithLinksToAdf('no links here');
    expect(doc.content).toHaveLength(1);
  });
});
