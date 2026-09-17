import { desc, eq, inArray } from 'drizzle-orm';
import { marked } from 'marked';
import type { AnyDb } from '../db/index.js';
import { workItems, approvals, executionTasks, slackSignals, briefings } from '../db/schema.js';
import type { JiraIssue, GitHubPr } from '../models/types.js';
import { summarizeConversations } from '../agents/slackIntelligence/conversationSummary.js';
import { timeEntriesInRange, formatMinutes } from '../agents/workLog/timeEntry.js';

const SLACK_CATEGORY_BADGE_CLASS: Record<string, string> = {
  urgent: 'risk-high',
  task_assignment: 'risk-high',
  decision_required: 'risk-medium',
  action_required: 'risk-medium',
  response_required: 'risk-low',
  important_context: '',
  informational: '',
  irrelevant: '',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function link(url: string | null | undefined, label: string): string {
  return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>` : escapeHtml(label);
}

const COPY_ICON =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';

function copyBtn(value: string): string {
  const v = escapeHtml(value);
  return `<button type="button" class="copy-btn" data-copy="${v}" title="Copy ${v}" aria-label="Copy ${v}">${COPY_ICON}</button>`;
}

/** POSTs to /start-task (see server.ts), which opens a real terminal on
 * your own machine running a real, interactive `claude` session already
 * primed with this ticket — exec-start's own eligibility check decides
 * what actually happens next, this button is just the "open terminal, cd,
 * type claude" step automated. */
function startTaskBtn(key: string): string {
  const k = escapeHtml(key);
  return `<button type="button" class="start-task-btn" data-key="${k}" data-action="work" title="Open a terminal and start a Claude Code session on ${k}">▶ Start</button>`;
}

/** POSTs to /estimate-task — read-only for now: the estimate is only
 * printed in the opened terminal, nothing is written to Jira/the
 * dashboard/anywhere else yet (deliberately deferred). */
function estimateTaskBtn(key: string): string {
  const k = escapeHtml(key);
  return `<button type="button" class="start-task-btn estimate-task-btn" data-key="${k}" data-action="estimate" title="Open a terminal and ask Claude Code for a time estimate on ${k}">⏱ Estimate</button>`;
}

/** The one place a ticket/PR id is ever rendered — a link (when a URL is
 * known) plus a copy icon, always together, so "copy this id" works
 * identically everywhere it appears. */
function idChip(label: string, url?: string | null): string {
  return `<span class="key-chip">${link(url, label)}${copyBtn(label)}</span>`;
}

const ACTION_LABEL: Record<string, string> = {
  manual_review_no_repo_mapping: 'No repository mapped for this ticket',
  manual_review_implementation_stopped: 'Implementer stopped itself',
  manual_review_failed_gate: 'Automated safety checks failed',
  manual_review_empty_diff: 'No changes were produced',
  manual_review_ticket_not_found: 'Ticket could not be found',
  log_execution_time: 'Log autonomous work time to Jira',
  send_slack_message: 'Send a Slack reply',
  investigate_ci_failure: 'CI is failing',
  respond_to_review_feedback: 'Review feedback needs a response',
  clarify_task_assignment: 'New assignment needs clarification',
  review_pull_request: 'Review this pull request',
  address_review_comments: 'Address review comments',
  create_branch_or_pr: 'Start work on this ticket',
  comment_asking_for_unblock_status: 'Ask for an unblock status update',
};

function humanizeAction(action: string): string {
  return ACTION_LABEL[action] ?? action.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

const EXEC_STATUS_LABEL: Record<string, string> = {
  selected: 'Picked up',
  implementing: 'Implementing',
  checking: 'Running checks',
  gated_stop: 'Stopped — needs review',
  pr_opened: 'PR opened',
  monitoring: 'Monitoring PR',
  done: 'Done',
  failed: 'Failed — needs review',
};

const CATEGORY_LABEL: Record<string, string> = {
  needs_review: 'Needs your review',
  needs_action: 'Needs your action',
  blocked: 'Blocked / on hold',
  waiting_on_others: 'Waiting on others',
  slack_mention: 'Slack mention',
  fyi: 'FYI',
};
const CATEGORY_ORDER = ['needs_review', 'needs_action', 'blocked', 'waiting_on_others', 'slack_mention', 'fyi'];
const OPEN_BY_DEFAULT = new Set(['needs_review', 'needs_action', 'blocked']);

const ACTIVE_TASK_STATUSES = new Set(['selected', 'implementing', 'checking', 'gated_stop', 'pr_opened', 'monitoring']);

function hasJiraCreds(): boolean {
  return !!(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);
}
function hasSlackCreds(): boolean {
  return !!(process.env.SLACK_USER_TOKEN && process.env.SLACK_USER_ID);
}

function connectorPill(name: string, live: boolean): string {
  return `<span class="pill ${live ? 'pill-live' : 'pill-mock'}"><i></i>${name} · ${live ? 'live' : 'mock'}</span>`;
}

function statCard(value: string | number, label: string, tone: 'accent' | 'ok' | 'warn' | 'danger' | 'neutral' = 'neutral'): string {
  return `<div class="stat stat-${tone}">
  <div class="stat-value">${value}</div>
  <div class="stat-label">${label}</div>
</div>`;
}

/** Purely client-side (see the script at the bottom) — filters this one
 * panel's own items, case-insensitive substring match against everything
 * visible in the card, not just the ticket key. No server round-trip. */
function searchBox(placeholder: string): string {
  const p = escapeHtml(placeholder);
  return `<div class="panel-search-wrap"><input type="text" class="panel-search" placeholder="${p}" aria-label="${p}"></div>`;
}

export async function renderDashboard(db: AnyDb): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const [items, pendingApprovals, resolvedApprovals, tasks, signals, latestBriefing, todayEntries] = await Promise.all([
    db.select().from(workItems).orderBy(desc(workItems.updatedAt)).limit(100),
    db.select().from(approvals).where(eq(approvals.status, 'pending')).orderBy(desc(approvals.createdAt)),
    db.select().from(approvals).where(inArray(approvals.status, ['approved', 'rejected'])).orderBy(desc(approvals.resolvedAt)).limit(30),
    db.select().from(executionTasks).orderBy(desc(executionTasks.updatedAt)).limit(20),
    db.select().from(slackSignals).orderBy(desc(slackSignals.createdAt)).limit(200),
    db.select().from(briefings).where(eq(briefings.kind, 'daily')).orderBy(desc(briefings.id)).limit(1),
    timeEntriesInRange(db, today, today),
  ]);

  const briefing = latestBriefing[0];
  const briefingHtml = briefing ? await marked.parse(briefing.content) : null;

  // So Slack signals / execution tasks (which only store a bare Jira key)
  // can still link out to the ticket, using whatever URL observation
  // already captured for that key.
  const jiraUrlByKey = new Map<string, string>();
  for (const item of items) {
    const jira = item.jira as JiraIssue | null;
    if (jira?.key && jira.url) jiraUrlByKey.set(jira.key, jira.url);
  }

  const byCategory = new Map<string, typeof items>();
  for (const item of items) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }

  const urgencyRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const highUrgencyCount = items.filter((i) => i.urgency === 'high').length;
  const activeTaskCount = tasks.filter((t) => ACTIVE_TASK_STATUSES.has(t.status)).length;
  const conversations = summarizeConversations(signals);
  const flaggedConvoCount = conversations.filter((c) => c.topCategory !== 'irrelevant' && c.topCategory !== 'informational').length;
  const minutesToday = todayEntries.reduce((sum, e) => sum + e.minutes, 0);

  const workItemSections = CATEGORY_ORDER.map((category) => {
    const list = byCategory.get(category);
    if (!list || list.length === 0) return '';
    list.sort((a, b) => (urgencyRank[a.urgency] ?? 9) - (urgencyRank[b.urgency] ?? 9));
    const rows = list
      .map((item) => {
        const jira = item.jira as JiraIssue | null;
        const prs = item.prs as GitHubPr[];
        const keyLabel = jira ? idChip(jira.key, jira.url) : idChip(item.id);
        // The descriptive summary is what answers "what is this, actually" —
        // it belongs in the prominent heading, not demoted below a bare key.
        const heading = jira?.summary ?? prs[0]?.title ?? '(no title)';
        const metaChips = jira
          ? `<span class="chip">${escapeHtml(jira.status)}</span><span class="chip">${escapeHtml(jira.priority)} priority</span><span class="chip">${escapeHtml(jira.project)}</span>`
          : '';
        const prLinks = prs
          .map((pr) => `<div class="pr-link">Linked PR: ${idChip(`${pr.repo}#${pr.number}`, pr.url)} — ${escapeHtml(pr.title)}</div>`)
          .join('');
        const reasons = (item.reasons as string[]).map((r) => `<li>${escapeHtml(r)}</li>`).join('');
        return `<div class="item-row urgency-${item.urgency}">
  <div class="item-top">
    <span class="item-key">${keyLabel}</span>
    <span class="badge urgency-${item.urgency}">${escapeHtml(item.urgency)}</span>
    ${metaChips}
    ${jira ? `<span class="item-top-spacer"></span>${estimateTaskBtn(jira.key)}${startTaskBtn(jira.key)}` : ''}
  </div>
  <div class="item-title">${escapeHtml(heading)}</div>
  ${prLinks}
  ${reasons ? `<div class="reasons-label">Why this needs attention</div><ul class="reasons">${reasons}</ul>` : ''}
</div>`;
      })
      .join('\n');
    // A high-urgency item must never hide inside a collapsed section, no
    // matter which category it landed in — that's exactly the gap that let
    // a still-high-urgency ticket (Jira priority independent of category)
    // look "gone" once it moved into a category that defaults to collapsed.
    const hasHighUrgency = list.some((item) => item.urgency === 'high');
    const open = OPEN_BY_DEFAULT.has(category) || hasHighUrgency;
    return `<details class="category" ${open ? 'open' : ''}>
  <summary><span>${CATEGORY_LABEL[category] ?? category}</span><span class="count">${list.length}</span></summary>
  <div class="category-body">${rows}</div>
</details>`;
  }).join('\n');

  const approvalsHtml =
    pendingApprovals.length === 0
      ? '<p class="empty">All clear — nothing waiting on a decision.</p>'
      : pendingApprovals
          .map(
            (a) => `<div class="card risk-${a.riskLevel}">
    <div class="approval-head"><span class="badge source">${escapeHtml(a.source)}</span><span class="badge risk-${a.riskLevel}">${escapeHtml(a.riskLevel)} risk</span></div>
    <div class="item-title">${escapeHtml(humanizeAction(a.action))}</div>
    <div class="item-sub">on ${idChip(a.target, a.targetUrl)}</div>
    <div class="item-summary">${escapeHtml(a.reasoning)}</div>
    <div class="recommended"><strong>Recommended:</strong> ${escapeHtml(a.recommendedAction)}</div>
    <div class="approve-cmd">npm run cli approvals approve ${escapeHtml(a.id)}<br>npm run cli approvals reject ${escapeHtml(a.id)}</div>
  </div>`,
          )
          .join('\n');

  const approvalHistoryHtml =
    resolvedApprovals.length === 0
      ? '<p class="empty">Nothing resolved yet.</p>'
      : resolvedApprovals
          .map((a) => {
            const statusClass = a.status === 'approved' ? 'risk-low' : 'risk-high';
            const when = a.resolvedAt ? new Date(a.resolvedAt).toLocaleString() : '';
            return `<div class="card compact ${statusClass}">
    <div class="approval-head"><span class="badge ${a.status === 'approved' ? 'status' : 'urgency-high'}">${escapeHtml(a.status)}</span><span class="badge source">${escapeHtml(a.source)}</span></div>
    <div class="item-title">${escapeHtml(humanizeAction(a.action))}</div>
    <div class="item-sub">on ${idChip(a.target, a.targetUrl)}${when ? ` — ${escapeHtml(when)}` : ''}</div>
  </div>`;
          })
          .join('\n');

  const tasksHtml =
    tasks.length === 0
      ? '<p class="empty">None yet.</p>'
      : tasks
          .slice(0, 8)
          .map((t) => {
            const jiraLink = t.jiraKey ? idChip(t.jiraKey, jiraUrlByKey.get(t.jiraKey)) : idChip(t.id);
            return `<div class="card compact">
  <div class="item-title">${jiraLink} <span class="badge status">${escapeHtml(EXEC_STATUS_LABEL[t.status] ?? t.status)}</span></div>
  ${t.branch ? `<div class="item-summary">branch: ${escapeHtml(t.branch)}</div>` : ''}
  ${t.prUrl ? `<div class="pr-link">↳ ${link(t.prUrl, t.prUrl)}</div>` : ''}
</div>`;
          })
          .join('\n');

  const signalsHtml =
    conversations.length === 0
      ? '<p class="empty">Nothing flagged.</p>'
      : conversations
          .slice(0, 10)
          .map((c) => {
            const badgeClass = SLACK_CATEGORY_BADGE_CLASS[c.topCategory] ?? '';
            const jiraLinks = c.linkedJiraKeys.map((key) => idChip(key, jiraUrlByKey.get(key))).join(', ');
            const rawMessages = c.messages
              .map((m) => `<div class="raw-msg"><span class="badge">${escapeHtml(m.category)}</span> ${escapeHtml(m.text)}</div>`)
              .join('\n');
            return `<div class="card compact ${badgeClass}">
  <div class="item-title">${escapeHtml(c.headline)}</div>
  ${jiraLinks ? `<div class="item-summary">Tickets: ${jiraLinks}</div>` : ''}
  <details>
    <summary>Show the ${c.messageCount} message${c.messageCount === 1 ? '' : 's'}</summary>
    ${rawMessages}
  </details>
</div>`;
          })
          .join('\n');

  const timeEntriesHtml =
    todayEntries.length === 0
      ? '<p class="empty">Nothing logged yet today.</p>'
      : todayEntries
          .map(
            (e) =>
              `<div class="time-row"><span>${e.jiraKey ? idChip(e.jiraKey, jiraUrlByKey.get(e.jiraKey)) : 'General'}${e.note ? ` — ${escapeHtml(e.note)}` : ''}</span><span class="time-amt">${formatMinutes(e.minutes)}</span></div>`,
          )
          .join('\n');

  const now = new Date();
  // What actually matters here is when Jira/Slack/GitHub were last really
  // fetched — not when this page happened to render. persistBriefing()
  // stamps createdAt fresh on every pipeline run (upsert, not insert-only),
  // so the daily briefing's createdAt is a true "data last synced at".
  const dataSyncedAt = briefing?.createdAt ?? null;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Work Agent</title>
<meta http-equiv="refresh" content="60">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<style>
  :root {
    --bg: #F1F4F5; --surface: #FFFFFF; --surface-2: #F7F9FA; --border: #E1E7E8;
    --text: #10181A; --muted: #5B6C6E; --faint: #8B9C9E;
    --accent: #0E7C74; --accent-strong: #0A5B55; --accent-wash: #E3F1EF;
    --high: #B23A34; --high-wash: #FBE9E7;
    --medium: #B9770E; --medium-wash: #FBF0DD;
    --low: #2B6CB0; --low-wash: #E7EFF7;
    --ok: #2E8B57; --mono: 'IBM Plex Mono', ui-monospace, monospace; --sans: 'IBM Plex Sans', -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0B1414; --surface: #101B1B; --surface-2: #162323; --border: #223333;
      --text: #E7F1F0; --muted: #9DB2B0; --faint: #6C8280;
      --accent: #2BB3A3; --accent-strong: #4FD1C0; --accent-wash: #142826;
      --high: #E0685F; --high-wash: #2B1715;
      --medium: #E0A73C; --medium-wash: #2B2210;
      --low: #6FA8DC; --low-wash: #16222E;
      --ok: #4CAF7D;
    }
  }
  * { box-sizing: border-box; }
  body { font-family: var(--sans); max-width: 1360px; margin: 0 auto; padding: 1.5rem 1.5rem 4rem; background: var(--bg); color: var(--text); line-height: 1.5; font-size: 14.5px; }
  a { color: var(--accent); }

  .topbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 1.4rem; }
  .brand { display: flex; align-items: baseline; gap: 0.6rem; }
  .brand h1 { font-family: var(--mono); font-size: 1.25rem; margin: 0; letter-spacing: -0.01em; }
  .brand .tagline { color: var(--muted); font-size: 0.82rem; }
  .meta { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .pill { font-family: var(--mono); font-size: 0.7rem; display: inline-flex; align-items: center; gap: 0.35rem; background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 0.2rem 0.6rem 0.2rem 0.5rem; color: var(--muted); }
  .pill i { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
  .pill-live i { background: var(--ok); }
  .pill-mock i { background: var(--faint); }
  .refresh-note { font-size: 0.72rem; color: var(--faint); font-family: var(--mono); }

  .stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 0.85rem 1rem; }
  .stat-value { font-family: var(--mono); font-weight: 700; font-size: 1.6rem; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .stat-label { color: var(--muted); font-size: 0.76rem; margin-top: 0.25rem; }
  .stat-accent .stat-value { color: var(--accent-strong); }
  .stat-danger .stat-value { color: var(--high); }
  .stat-warn .stat-value { color: var(--medium); }
  .stat-ok .stat-value { color: var(--ok); }

  .grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 1.25rem; align-items: start; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }

  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1.1rem 1.2rem; margin-bottom: 1.25rem; }
  .panel-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 0.7rem; }
  .panel-head h2 { font-size: 0.95rem; margin: 0; }
  .panel-head .count { font-family: var(--mono); font-size: 0.78rem; color: var(--muted); }

  .panel-search-wrap { margin-bottom: 0.6rem; }
  .panel-search {
    width: 100%; font-family: var(--sans); font-size: 0.82rem; color: var(--text);
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 7px;
    padding: 0.4rem 0.65rem; outline: none;
  }
  .panel-search::placeholder { color: var(--faint); }
  .panel-search:focus { border-color: var(--accent); }

  .card, .item-row { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 0.7rem 0.9rem; margin: 0.5rem 0; }
  .card.compact { padding: 0.55rem 0.8rem; }
  .item-row { border-left: 3px solid var(--border); }
  .item-row.urgency-high { border-left-color: var(--high); }
  .item-row.urgency-medium { border-left-color: var(--medium); }
  .item-row.urgency-low { border-left-color: var(--low); }
  .card.risk-high { border-left: 3px solid var(--high); }
  .card.risk-medium { border-left: 3px solid var(--medium); }
  .card.risk-low { border-left: 3px solid var(--low); }
  .item-title { font-weight: 600; font-size: 0.95rem; color: var(--text); }
  .item-title a { text-decoration: none; } .item-title a:hover { text-decoration: underline; }
  .item-sub { color: var(--muted); font-size: 0.8rem; margin-top: 0.15rem; }
  .item-summary { color: var(--muted); font-size: 0.83rem; margin-top: 0.2rem; }
  .pr-link { font-size: 0.78rem; color: var(--muted); margin-top: 0.3rem; }
  .reasons-label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--faint); margin-top: 0.5rem; }
  .reasons { margin: 0.2rem 0 0; padding-left: 1.1rem; font-size: 0.78rem; color: var(--muted); }

  .item-top { display: flex; align-items: center; flex-wrap: wrap; gap: 0.35rem; margin-bottom: 0.3rem; }
  .item-top-spacer { flex: 1 1 auto; }
  .start-task-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 0.3rem;
    font-family: var(--mono); font-size: 0.72rem; font-weight: 600; line-height: 1.4; white-space: nowrap;
    background: var(--accent-wash); color: var(--accent-strong); border: 1px solid var(--accent);
    border-radius: 6px; padding: 0.2rem 0.55rem; height: 1.9rem; cursor: pointer; vertical-align: middle;
  }
  .start-task-btn:hover { background: var(--accent); color: var(--surface); }
  .start-task-btn:disabled { opacity: 0.6; cursor: default; background: var(--accent-wash); color: var(--accent-strong); }
  .estimate-task-btn { background: var(--surface); color: var(--muted); border-color: var(--border); }
  .estimate-task-btn:hover { background: var(--surface-2); color: var(--text); }
  .estimate-task-btn:disabled { background: var(--surface); color: var(--muted); }
  .item-key { font-family: var(--mono); font-size: 0.8rem; font-weight: 600; color: var(--muted); }
  .item-key a { color: var(--muted); }
  .chip { display: inline-block; font-size: 0.66rem; background: var(--surface); border: 1px solid var(--border); color: var(--muted); padding: 0.1rem 0.45rem; border-radius: 8px; white-space: nowrap; }

  .key-chip { display: inline-flex; align-items: center; gap: 0.2rem; }
  .copy-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 18px; height: 18px; padding: 0; border: none; border-radius: 4px;
    background: transparent; color: var(--faint); cursor: pointer; flex-shrink: 0;
  }
  .copy-btn:hover { background: var(--surface-2); color: var(--accent); }
  .copy-btn.copied { color: var(--ok); }
  .empty { color: var(--muted); font-size: 0.85rem; font-style: italic; }
  .badge { display: inline-block; font-size: 0.63rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.02em; padding: 0.15rem 0.5rem; border-radius: 10px; background: var(--surface); color: var(--muted); margin-left: 0.4rem; }
  .badge.urgency-high, .badge.risk-high { background: var(--high-wash); color: var(--high); }
  .badge.urgency-medium, .badge.risk-medium { background: var(--medium-wash); color: var(--medium); }
  .badge.urgency-low, .badge.risk-low { background: var(--low-wash); color: var(--low); }
  .badge.source { background: var(--accent-wash); color: var(--accent-strong); }
  .badge.status { background: var(--accent-wash); color: var(--accent-strong); }
  .approval-head { margin-bottom: 0.3rem; }
  .recommended { font-size: 0.82rem; margin-top: 0.4rem; }
  .approve-cmd { font-family: var(--mono); font-size: 0.7rem; background: var(--surface); border: 1px solid var(--border); border-radius: 5px; padding: 0.4rem 0.6rem; margin-top: 0.5rem; color: var(--muted); white-space: pre; overflow-x: auto; }

  details.category { border: 1px solid var(--border); border-radius: 8px; margin: 0.5rem 0; background: var(--surface-2); }
  details.category summary { list-style: none; cursor: pointer; display: flex; justify-content: space-between; padding: 0.6rem 0.9rem; font-size: 0.82rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); }
  details.category summary::-webkit-details-marker { display: none; }
  details.category summary .count { font-family: var(--mono); color: var(--faint); text-transform: none; letter-spacing: 0; }
  .category-body { padding: 0 0.9rem 0.7rem; }

  details { margin-top: 0.4rem; }
  details summary { cursor: pointer; font-size: 0.78rem; color: var(--accent); user-select: none; }
  .raw-msg { font-size: 0.8rem; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem 0.7rem; margin-top: 0.4rem; }

  .time-row { display: flex; justify-content: space-between; font-size: 0.83rem; padding: 0.35rem 0; border-bottom: 1px solid var(--border); }
  .time-row:last-child { border-bottom: none; }
  .time-amt { font-family: var(--mono); font-weight: 700; color: var(--accent-strong); font-variant-numeric: tabular-nums; }
  .log-hint { font-family: var(--mono); font-size: 0.68rem; color: var(--faint); margin-top: 0.5rem; }

  .briefing { font-size: 0.87rem; }
  .briefing h1 { font-size: 1rem; margin: 0 0 0.5rem; }
  .briefing h2 { font-size: 0.9rem; margin: 0.9rem 0 0.35rem; }
  .briefing ul { padding-left: 1.2rem; }
  .briefing li { margin: 0.2rem 0; }
  .briefing strong { color: var(--accent-strong); }

  .actions-note { font-size: 0.78rem; color: var(--faint); border-top: 1px solid var(--border); margin-top: 1.5rem; padding-top: 1rem; }
  .actions-note code { font-family: var(--mono); background: var(--surface); border: 1px solid var(--border); padding: 0.05rem 0.35rem; border-radius: 4px; }
</style>
</head>
<body>

<div class="topbar">
  <div class="brand">
    <h1>Work Agent</h1>
    <span class="tagline">Live view of your day</span>
  </div>
  <div class="meta">
    ${connectorPill('Jira', hasJiraCreds())}
    ${connectorPill('GitHub', true)}
    ${connectorPill('Slack', hasSlackCreds())}
    <span class="refresh-note">data synced ${dataSyncedAt ? dataSyncedAt.toLocaleTimeString() : 'never yet'} · page checked ${now.toLocaleTimeString()}</span>
  </div>
</div>

<div class="stat-row">
  ${statCard(pendingApprovals.length, 'Waiting on your decision', pendingApprovals.length > 0 ? 'accent' : 'ok')}
  ${statCard(highUrgencyCount, 'High-urgency tickets', highUrgencyCount > 0 ? 'danger' : 'ok')}
  ${statCard(activeTaskCount, 'In progress (execution)', activeTaskCount > 0 ? 'warn' : 'neutral')}
  ${statCard(flaggedConvoCount, 'Slack conversations flagged', flaggedConvoCount > 0 ? 'warn' : 'ok')}
  ${statCard(minutesToday > 0 ? formatMinutes(minutesToday) : '0m', 'Time logged today', 'neutral')}
</div>

<div class="grid">
  <div class="main">
    <div class="panel">
      <div class="panel-head"><h2>Needs your decision</h2><span class="count">${pendingApprovals.length}</span></div>
      ${pendingApprovals.length > 0 ? searchBox('Search pending approvals…') : ''}
      ${approvalsHtml}
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Approval history</h2><span class="count">${resolvedApprovals.length}</span></div>
      ${resolvedApprovals.length > 0 ? searchBox('Search approval history…') : ''}
      <details>
        <summary>Show the last ${resolvedApprovals.length} resolved</summary>
        ${approvalHistoryHtml}
      </details>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Active work items</h2><span class="count">${items.length}</span></div>
      ${items.length > 0 ? searchBox('Search your tickets…') : ''}
      ${workItemSections || '<p class="empty">Nothing tracked yet — run <code>npm run cli run</code>.</p>'}
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Latest daily briefing</h2></div>
      ${
        briefingHtml
          ? `<details><summary>Show full briefing</summary><div class="briefing">${briefingHtml}</div></details>`
          : '<p class="empty">No briefing generated yet — run <code>npm run cli run</code>.</p>'
      }
    </div>
  </div>

  <div class="side">
    <div class="panel">
      <div class="panel-head"><h2>Today</h2></div>
      ${timeEntriesHtml}
      <div class="log-hint">work-agent log-time --minutes N [--ticket KEY]</div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Slack — needs attention</h2><span class="count">${conversations.length}</span></div>
      ${conversations.length > 0 ? searchBox('Search conversations…') : ''}
      ${signalsHtml}
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Engineering execution</h2><span class="count">${tasks.length}</span></div>
      ${tasks.length > 0 ? searchBox('Search execution tasks…') : ''}
      ${tasksHtml}
    </div>
  </div>
</div>

<p class="actions-note">Read-only. To act: <code>npm run cli approvals approve|reject &lt;id&gt;</code>, or ask me directly in a live session.</p>

<script>
(function () {
  var CHECK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.copy-btn');
    if (!btn) return;
    var value = btn.getAttribute('data-copy') || '';
    var restore = btn.innerHTML;
    navigator.clipboard.writeText(value).then(function () {
      btn.innerHTML = CHECK;
      btn.classList.add('copied');
      setTimeout(function () {
        btn.innerHTML = restore;
        btn.classList.remove('copied');
      }, 1200);
    });
  });

  // "Start"/"Estimate" buttons — both open a real terminal on this machine
  // (see /start-task and /estimate-task in server.ts) running a real,
  // interactive claude session already told what to do with this ticket.
  // Purely a convenience over typing the same commands by hand; whatever
  // that session actually does next is entirely up to it (and, for "Start",
  // exec-start's own eligibility check) — this just opens the terminal.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.start-task-btn');
    if (!btn) return;
    var key = btn.getAttribute('data-key') || '';
    var action = btn.getAttribute('data-action') || 'work';
    var endpoint = action === 'estimate' ? '/estimate-task' : '/start-task';
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = action === 'estimate' ? 'Opening…' : 'Starting…';
    fetch(endpoint + '?key=' + encodeURIComponent(key), { method: 'POST' })
      .then(function (r) {
        return r.json().then(function (data) { return { ok: r.ok, data: data }; });
      })
      .then(function (result) {
        if (result.ok) {
          btn.textContent = action === 'estimate' ? 'Opened ✓' : 'Started ✓';
          setTimeout(function () {
            btn.textContent = original;
            btn.disabled = false;
          }, 4000);
        } else {
          alert('Could not open a session: ' + (result.data && result.data.error ? result.data.error : 'unknown error'));
          btn.textContent = original;
          btn.disabled = false;
        }
      })
      .catch(function (err) {
        alert('Could not open a session: ' + err);
        btn.textContent = original;
        btn.disabled = false;
      });
  });

  // Per-panel search — purely client-side, filters this panel's own
  // .item-row/.card elements by case-insensitive substring match against
  // everything visible in the card (title, ticket key, reasons, etc), not
  // just the ticket id. A category or a collapsible <details> auto-opens
  // when it contains a match, and restores its original open/closed state
  // once the search is cleared.
  document.addEventListener('input', function (e) {
    var input = e.target.closest('.panel-search');
    if (!input) return;
    var panel = input.closest('.panel');
    if (!panel) return;
    var query = input.value.trim().toLowerCase();

    var items = panel.querySelectorAll('.item-row, .card');
    items.forEach(function (item) {
      var matches = !query || item.textContent.toLowerCase().indexOf(query) !== -1;
      item.hidden = !matches;
      if (matches && query) {
        var ancestor = item.closest('details');
        if (ancestor) ancestor.open = true;
      }
    });

    var categories = panel.querySelectorAll('details.category');
    categories.forEach(function (cat) {
      if (cat.dataset.wasOpen === undefined) cat.dataset.wasOpen = cat.open ? '1' : '0';
      if (!query) {
        cat.hidden = false;
        cat.open = cat.dataset.wasOpen === '1';
        return;
      }
      var visibleCount = cat.querySelectorAll('.item-row:not([hidden])').length;
      cat.hidden = visibleCount === 0;
    });

    var plainDetails = panel.querySelectorAll('details:not(.category)');
    plainDetails.forEach(function (d) {
      if (d.dataset.wasOpen === undefined) d.dataset.wasOpen = d.open ? '1' : '0';
      if (!query) d.open = d.dataset.wasOpen === '1';
    });
  });
})();
</script>

</body>
</html>`;
}
