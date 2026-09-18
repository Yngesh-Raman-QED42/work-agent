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

// ---------------------------------------------------------------------------
// Reading ADF back — used by the dashboard's ticket-detail dialog to render
// a real description/comment instead of a flattened wall of text. Covers
// the node/mark types that actually show up in real-world tickets; anything
// unrecognized is skipped rather than thrown on, since a renderer choking
// on one exotic node (a Jira "status" lozenge, a table, an emoji node) would
// take down the whole dialog over content that was never critical to see.
// ---------------------------------------------------------------------------

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  attrs?: Record<string, unknown>;
}

function escapeHtmlForAdf(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function markedText(node: AdfNode): string {
  let html = escapeHtmlForAdf(node.text ?? '').replace(/\n/g, '<br>');
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case 'strong':
        html = `<strong>${html}</strong>`;
        break;
      case 'em':
        html = `<em>${html}</em>`;
        break;
      case 'strike':
        html = `<s>${html}</s>`;
        break;
      case 'underline':
        html = `<u>${html}</u>`;
        break;
      case 'code':
        html = `<code>${html}</code>`;
        break;
      case 'link': {
        const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : '';
        if (href) html = `<a href="${escapeHtmlForAdf(href)}" target="_blank" rel="noopener">${html}</a>`;
        break;
      }
      default:
        break; // unrecognized mark — keep the text, drop only the styling
    }
  }
  return html;
}

function renderNode(node: AdfNode): string {
  const children = (node.content ?? []).map(renderNode).join('');
  switch (node.type) {
    case 'doc':
      return children;
    case 'paragraph':
      return `<p>${children}</p>`;
    case 'text':
      return markedText(node);
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 3, 1), 6);
      return `<h${level}>${children}</h${level}>`;
    }
    case 'bulletList':
      return `<ul>${children}</ul>`;
    case 'orderedList':
      return `<ol>${children}</ol>`;
    case 'listItem':
      return `<li>${children}</li>`;
    case 'blockquote':
      return `<blockquote>${children}</blockquote>`;
    case 'codeBlock':
      return `<pre><code>${children}</code></pre>`;
    case 'rule':
      return '<hr>';
    case 'hardBreak':
      return '<br>';
    case 'mention':
      return `<span class="adf-mention">@${escapeHtmlForAdf(String(node.attrs?.text ?? 'mention'))}</span>`;
    case 'inlineCard':
    case 'blockCard': {
      const url = typeof node.attrs?.url === 'string' ? node.attrs.url : '';
      return url ? `<a href="${escapeHtmlForAdf(url)}" target="_blank" rel="noopener">${escapeHtmlForAdf(url)}</a>` : '';
    }
    case 'table':
      return `<table class="adf-table">${children}</table>`;
    case 'tableRow':
      return `<tr>${children}</tr>`;
    case 'tableHeader':
      return `<th>${children}</th>`;
    case 'tableCell':
      return `<td>${children}</td>`;
    default:
      // Anything else (panel, media, emoji, status, expand, etc.) — best
      // effort: render its children if it has any, so nested text isn't
      // silently lost, otherwise contribute nothing.
      return children;
  }
}

/** Renders a Jira ADF document (or plain string, for the rare field that
 * isn't ADF) to sanitized HTML — every piece of real text goes through
 * escapeHtmlForAdf, so this is safe to insert as innerHTML. */
export function adfToHtml(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return `<p>${escapeHtmlForAdf(value)}</p>`;
  return renderNode(value as AdfNode);
}

/** Flat plain-text extraction — used to pre-fill the description edit
 * textarea, where markup would just be noise the user didn't type. */
export function adfToPlainText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as AdfNode;
    if (n.type === 'text' && n.text) parts.push(n.text);
    if (n.type === 'hardBreak') parts.push('\n');
    if (Array.isArray(n.content)) n.content.forEach(walk);
    if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem') parts.push('\n');
  };
  walk(value);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}
