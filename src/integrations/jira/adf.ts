// Shared Atlassian Document Format (ADF) builders — used by every Jira
// write path (worklog comments, status-change comments) so a link always
// renders as an actual clickable link, not bare text Jira's renderer
// leaves unlinked (unlike typing/pasting in the editor, the REST API does
// not auto-linkify plain-text nodes).

export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: unknown[];
}

export function plainTextToAdf(text: string): AdfDoc {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/** A paragraph of plain text, followed by one paragraph per link — each
 * rendered as a real ADF link mark so it's clickable in the Jira UI. */
export function textWithLinksToAdf(text: string, links: Array<{ label: string; url: string }> = []): AdfDoc {
  return {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text }] },
      ...links.map((link) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: link.label, marks: [{ type: 'link', attrs: { href: link.url } }] }],
      })),
    ],
  };
}
