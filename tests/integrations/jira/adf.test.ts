import { describe, expect, it } from 'vitest';
import { plainTextToAdf, textWithLinksToAdf, adfToHtml, adfToPlainText } from '../../../src/integrations/jira/adf.js';

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

describe('adfToHtml', () => {
  it('renders paragraphs, headings, and lists', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Steps' }] },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] },
          ],
        },
      ],
    };
    const html = adfToHtml(doc);
    expect(html).toBe('<h2>Steps</h2><ul><li><p>first</p></li><li><p>second</p></li></ul>');
  });

  it('renders marks: bold, italic, code, and a real clickable link', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'a link', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
          ],
        },
      ],
    };
    const html = adfToHtml(doc);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener">a link</a>');
  });

  it('escapes text content — this gets inserted as innerHTML on the dashboard', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script>' }] }],
    };
    const html = adfToHtml(doc);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('does not throw on an unrecognized node type — renders its children instead of dropping the whole doc', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'someExoticJiraNode', content: [{ type: 'text', text: 'inside exotic node' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
      ],
    };
    expect(() => adfToHtml(doc)).not.toThrow();
    const html = adfToHtml(doc);
    expect(html).toContain('before');
    expect(html).toContain('inside exotic node');
    expect(html).toContain('after');
  });

  it('a bare string (the rare non-ADF field) still renders as a paragraph', () => {
    expect(adfToHtml('plain text field')).toBe('<p>plain text field</p>');
  });

  it('null/undefined renders as empty', () => {
    expect(adfToHtml(null)).toBe('');
    expect(adfToHtml(undefined)).toBe('');
  });
});

describe('adfToPlainText', () => {
  it('flattens paragraphs onto separate lines, dropping all markup', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'first paragraph' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'second paragraph', marks: [{ type: 'strong' }] }] },
      ],
    };
    expect(adfToPlainText(doc)).toBe('first paragraph\nsecond paragraph');
  });

  it('a bare string passes through unchanged', () => {
    expect(adfToPlainText('already plain')).toBe('already plain');
  });

  it('null/undefined flattens to empty string', () => {
    expect(adfToPlainText(null)).toBe('');
    expect(adfToPlainText(undefined)).toBe('');
  });
});
