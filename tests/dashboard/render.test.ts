import { describe, expect, it, afterEach } from 'vitest';
import { createTestDb, type TestDbHandle } from '../../src/test-utils/db.js';
import { renderDashboard } from '../../src/dashboard/render.js';
import { ApprovalsStore } from '../../src/shared/approvals.js';
import { slackSignals, workItems } from '../../src/db/schema.js';

let handle: TestDbHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

describe('renderDashboard', () => {
  it('renders without data', async () => {
    handle = await createTestDb();
    const html = await renderDashboard(handle.db);
    expect(html).toContain('Work Agent');
    expect(html).toContain('All clear — nothing waiting on a decision.');
  });

  it('shows no search box for an empty panel, but does once it has content', async () => {
    handle = await createTestDb();
    const empty = await renderDashboard(handle.db);
    // The class name legitimately appears in the static CSS/JS regardless —
    // check for an actual rendered <input>, not just the substring.
    expect(empty).not.toContain('<input type="text" class="panel-search"');

    await new ApprovalsStore(handle.db).file({
      id: 'a1', source: 'observation', action: 'review_pull_request', target: 'org/repo#1',
      context: {}, reasoning: 'x', riskLevel: 'low', consequenceIfApproved: 'x', recommendedAction: 'x',
    });
    const withData = await renderDashboard(handle.db);
    expect(withData).toContain('Search pending approvals…');
  });

  it('lists resolved approvals under Approval history, separate from the pending queue', async () => {
    handle = await createTestDb();
    const store = new ApprovalsStore(handle.db);
    await store.file({
      id: 'a-approved', source: 'engineering_execution', action: 'log_execution_time', target: 'PROJ-1',
      context: {}, reasoning: 'x', riskLevel: 'low', consequenceIfApproved: 'x', recommendedAction: 'x',
    });
    await store.resolve('a-approved', 'approved');
    await store.file({
      id: 'a-rejected', source: 'observation', action: 'create_branch_or_pr', target: 'PROJ-2',
      context: {}, reasoning: 'x', riskLevel: 'low', consequenceIfApproved: 'x', recommendedAction: 'x',
    });
    await store.resolve('a-rejected', 'rejected');

    const html = await renderDashboard(handle.db);
    expect(html).toContain('<h2>Approval history</h2><span class="count">2</span>');
    expect(html).toContain('approved');
    expect(html).toContain('rejected');
    // Resolved items must not also appear in the pending "Needs your decision" queue.
    expect(html).toContain('All clear — nothing waiting on a decision.');
  });

  it('renders a pending approval and escapes its content', async () => {
    handle = await createTestDb();
    await new ApprovalsStore(handle.db).file({
      id: 'a1',
      source: 'observation',
      action: 'review_pull_request',
      target: '<script>alert(1)</script>',
      context: {},
      reasoning: 'x',
      riskLevel: 'high',
      consequenceIfApproved: 'x',
      recommendedAction: 'review it',
    });
    const html = await renderDashboard(handle.db);
    expect(html).toContain('Review this pull request'); // humanized, not the raw action id
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    // The target still gets a copy button, escaped the same as everything else.
    expect(html).toContain('data-copy="&lt;script&gt;alert(1)&lt;/script&gt;"');
  });

  it('gives an unrecognized action a readable fallback instead of the raw snake_case id', async () => {
    handle = await createTestDb();
    await new ApprovalsStore(handle.db).file({
      id: 'a2',
      source: 'observation',
      action: 'some_future_action_type',
      target: 'PROJ-1',
      context: {},
      reasoning: 'x',
      riskLevel: 'low',
      consequenceIfApproved: 'x',
      recommendedAction: 'x',
    });
    const html = await renderDashboard(handle.db);
    expect(html).toContain('Some future action type');
  });

  it('puts a copy button with the right value next to a work item\'s ticket key', async () => {
    handle = await createTestDb();
    await handle.db.insert(workItems).values({
      id: 'PROJ-9',
      category: 'needs_action',
      urgency: 'medium',
      jiraKey: 'PROJ-9',
      jira: { key: 'PROJ-9', project: 'PROJ', summary: 'Fix the thing', status: 'In Progress', statusCategory: 'In Progress', priority: 'Medium', updated: new Date().toISOString(), url: 'http://x/PROJ-9' },
      prs: [],
      slackMessages: [],
      reasons: [],
      firstSeenAt: new Date(),
      updatedAt: new Date(),
    });
    const html = await renderDashboard(handle.db);
    // The descriptive summary is the prominent heading now, not the bare key.
    expect(html).toContain('<div class="item-title">Fix the thing</div>');
    expect(html).toContain('data-copy="PROJ-9"');
    expect(html).toContain('In Progress');
    expect(html).toContain('Medium priority');
  });

  it('shows a merge-conflicts badge next to a PR that has one, and none for a clean PR', async () => {
    handle = await createTestDb();
    const now = new Date();
    await handle.db.insert(workItems).values({
      id: 'PROJ-10',
      category: 'needs_action',
      urgency: 'high',
      jiraKey: 'PROJ-10',
      jira: { key: 'PROJ-10', project: 'PROJ', summary: 'Has a conflicting PR', status: 'In Progress', statusCategory: 'In Progress', priority: 'Medium', updated: now.toISOString(), url: 'http://x/PROJ-10' },
      prs: [
        {
          repo: 'org/repo', number: 70, title: 'PROJ-10: fix', url: 'http://x/pr/70',
          state: 'open', isDraft: false, branch: 'feat/proj-10', isAuthor: true,
          reviewRequestedOfMe: false, reviewState: 'none', updatedAt: now.toISOString(), hasConflicts: true,
        },
      ],
      slackMessages: [],
      reasons: ['Your PR org/repo#70 has merge conflicts that need resolving'],
      firstSeenAt: now,
      updatedAt: now,
    });
    await handle.db.insert(workItems).values({
      id: 'PROJ-11',
      category: 'waiting_on_others',
      urgency: 'medium',
      jiraKey: 'PROJ-11',
      jira: { key: 'PROJ-11', project: 'PROJ', summary: 'Clean PR', status: 'In Progress', statusCategory: 'In Progress', priority: 'Medium', updated: now.toISOString(), url: 'http://x/PROJ-11' },
      prs: [
        {
          repo: 'org/repo', number: 71, title: 'PROJ-11: fix', url: 'http://x/pr/71',
          state: 'open', isDraft: false, branch: 'feat/proj-11', isAuthor: true,
          reviewRequestedOfMe: false, reviewState: 'none', updatedAt: now.toISOString(), hasConflicts: false,
        },
      ],
      slackMessages: [],
      reasons: [],
      firstSeenAt: now,
      updatedAt: now,
    });
    const html = await renderDashboard(handle.db);
    // The conflicting PR's own line ends cleanly...
    expect(html).toContain('— PROJ-10: fix</div>');
    // ...followed by its own conflict row: the badge and a "Resolve
    // conflict" button referencing that exact PR.
    expect(html).toContain('<div class="pr-conflict-row"><span class="badge urgency-high">⚠ Merge conflicts</span>');
    expect(html).toContain('data-endpoint="/resolve-conflict"');
    // & is HTML-escaped to &amp; within the attribute value.
    expect(html).toContain('repo=org%2Frepo&amp;number=70&amp;title=PROJ-10%3A%20fix&amp;branch=feat%2Fproj-10');
    // The clean PR gets neither the badge nor the button.
    expect(html).toContain('— PROJ-11: fix</div>');
    expect(html).not.toContain('org%2Frepo&number=71');
  });

  it('groups multiple Slack messages from one conversation into a single headline, raw text hidden by default', async () => {
    handle = await createTestDb();
    const now = new Date();
    await handle.db.insert(slackSignals).values([
      {
        id: 'C1:1',
        channel: 'C1',
        channelName: 'DM: Vidit Anjaria',
        category: 'response_required',
        text: 'any progress made on the above mentioned epic and issues?',
        linkedJiraKey: null,
        createdAt: now,
      },
      {
        id: 'C1:2',
        channel: 'C1',
        channelName: 'DM: Vidit Anjaria',
        category: 'response_required',
        text: 'has this got deprioritise?',
        linkedJiraKey: null,
        createdAt: now,
      },
    ]);

    const html = await renderDashboard(handle.db);
    // One conversation card, not two raw message rows.
    expect(html).toContain('<h2>Slack — needs attention</h2><span class="count">1</span>');
    expect(html).toContain('Waiting on your response');
    expect(html).toContain('2 messages');
    // Raw text exists (inside the collapsible detail) but is not the headline.
    expect(html).toContain('has this got deprioritise?');
    expect(html).toContain('<details>');
    expect(html).toContain('<summary>');
  });

  it('never collapses a category section that contains a high-urgency item, even one not open by default', async () => {
    handle = await createTestDb();
    const now = new Date();
    // "waiting_on_others" is deliberately NOT in OPEN_BY_DEFAULT — this is
    // exactly the real case that surfaced the bug: a ticket whose Jira
    // priority forces urgency=high regardless of its category.
    await handle.db.insert(workItems).values({
      id: 'PROJ-1',
      category: 'waiting_on_others',
      urgency: 'high',
      jiraKey: 'PROJ-1',
      jira: { key: 'PROJ-1', project: 'PROJ', summary: 's', status: 'Ready for QA', statusCategory: 'In Progress', priority: 'High', updated: now.toISOString(), url: 'http://x' },
      prs: [],
      slackMessages: [],
      reasons: ['PROJ-1 priority is High'],
      firstSeenAt: now,
      updatedAt: now,
    });
    const html = await renderDashboard(handle.db);
    const sectionMatch = html.match(/<details class="category" *(open)? *>\s*<summary><span>Waiting on others<\/span>/);
    expect(sectionMatch).not.toBeNull();
    expect(sectionMatch![1]).toBe('open');
  });

  it('"Active work items" renders before "Needs your decision" in the page — the requested reorder', async () => {
    handle = await createTestDb();
    const html = await renderDashboard(handle.db);
    expect(html.indexOf('<h2>Active work items</h2>')).toBeLessThan(html.indexOf('<h2>Needs your decision</h2>'));
    expect(html.indexOf('<h2>Needs your decision</h2>')).toBeLessThan(html.indexOf('<h2>Approval history</h2>'));
  });

  it('lists a ticket with a PR merged within the last 7 days under "Recently merged"', async () => {
    handle = await createTestDb();
    const now = new Date();
    const recentlyClosedAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
    await handle.db.insert(workItems).values({
      id: 'PROJ-1',
      category: 'fyi',
      urgency: 'low',
      jiraKey: 'PROJ-1',
      jira: { key: 'PROJ-1', project: 'PROJ', summary: 'Fix the thing', status: 'In Progress', statusCategory: 'In Progress', priority: 'Medium', updated: now.toISOString(), url: 'http://x/PROJ-1' },
      prs: [
        {
          repo: 'org/repo', number: 42, title: 'PROJ-1: fix the thing', url: 'http://x/pr/42',
          state: 'merged', isDraft: false, branch: 'work-agent/proj-1', isAuthor: true,
          reviewRequestedOfMe: false, reviewState: 'none', updatedAt: recentlyClosedAt, closedAt: recentlyClosedAt,
        },
      ],
      slackMessages: [],
      reasons: [],
      firstSeenAt: now,
      updatedAt: now,
    });
    const html = await renderDashboard(handle.db);
    expect(html).toContain('<h2>Recently merged</h2><span class="count">1</span>');
    expect(html).toContain('Fix the thing');
    expect(html).toContain('org/repo#42');
    // Its own Recently merged card can still open the detail dialog...
    expect(html).toContain('data-ticket-key="PROJ-1"');
    // ...but it's a "fyi" ticket whose only signal is the merge itself,
    // which Recently merged already covers — it shouldn't also sit in
    // Active work items as a duplicate, nor carry Start/Estimate (nothing
    // left to start or estimate on already-merged work).
    expect(html).toContain('<h2>Active work items</h2><span class="count">0</span>');
    expect(html).not.toContain('data-key="PROJ-1" data-action="work"');
    expect(html).not.toContain('data-key="PROJ-1" data-action="estimate"');
  });

  it('a recently-merged ticket that still lands in a real actionable category (not fyi) stays visible in Active work items, with its own CTAs', async () => {
    handle = await createTestDb();
    const now = new Date();
    const recentlyClosedAt = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
    await handle.db.insert(workItems).values({
      id: 'PROJ-3',
      category: 'needs_review', // e.g. an unrelated second PR on this ticket still needs review
      urgency: 'high',
      jiraKey: 'PROJ-3',
      jira: { key: 'PROJ-3', project: 'PROJ', summary: 'Two PRs, one merged', status: 'In Progress', statusCategory: 'In Progress', priority: 'Medium', updated: now.toISOString(), url: 'http://x/PROJ-3' },
      prs: [
        {
          repo: 'org/repo', number: 50, title: 'PROJ-3: first fix', url: 'http://x/pr/50',
          state: 'merged', isDraft: false, branch: 'work-agent/proj-3-a', isAuthor: true,
          reviewRequestedOfMe: false, reviewState: 'none', updatedAt: recentlyClosedAt, closedAt: recentlyClosedAt,
        },
        {
          repo: 'org/repo', number: 51, title: 'PROJ-3: second fix', url: 'http://x/pr/51',
          state: 'open', isDraft: false, branch: 'work-agent/proj-3-b', isAuthor: false,
          reviewRequestedOfMe: true, reviewState: 'none', updatedAt: now.toISOString(),
        },
      ],
      slackMessages: [],
      reasons: ['Review requested on org/repo#51'],
      firstSeenAt: now,
      updatedAt: now,
    });
    const html = await renderDashboard(handle.db);
    expect(html).toContain('<h2>Active work items</h2><span class="count">1</span>');
    expect(html).toContain('data-key="PROJ-3" data-action="work"');
    expect(html).toContain('data-key="PROJ-3" data-action="estimate"');
  });

  it('suppresses Start/Estimate on a pending-approval card whose target ticket is already recently merged', async () => {
    handle = await createTestDb();
    const now = new Date();
    const recentlyClosedAt = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
    await handle.db.insert(workItems).values({
      id: 'PROJ-4',
      category: 'fyi',
      urgency: 'low',
      jiraKey: 'PROJ-4',
      jira: { key: 'PROJ-4', project: 'PROJ', summary: 'Already merged', status: 'In Progress', statusCategory: 'In Progress', priority: 'Medium', updated: now.toISOString(), url: 'http://x/PROJ-4' },
      prs: [
        {
          repo: 'org/repo', number: 60, title: 'PROJ-4: fix', url: 'http://x/pr/60',
          state: 'merged', isDraft: false, branch: 'work-agent/proj-4', isAuthor: true,
          reviewRequestedOfMe: false, reviewState: 'none', updatedAt: recentlyClosedAt, closedAt: recentlyClosedAt,
        },
      ],
      slackMessages: [],
      reasons: [],
      firstSeenAt: now,
      updatedAt: now,
    });
    await new ApprovalsStore(handle.db).file({
      id: 'exec-log-time:PROJ-4', source: 'engineering_execution', action: 'log_execution_time', target: 'PROJ-4',
      context: {}, reasoning: 'x', riskLevel: 'low', consequenceIfApproved: 'x', recommendedAction: 'x',
    });
    const html = await renderDashboard(handle.db);
    expect(html).not.toContain('data-key="PROJ-4" data-action="work"');
    expect(html).not.toContain('data-key="PROJ-4" data-action="estimate"');
  });

  it('does not list a PR merged more than 7 days ago under "Recently merged"', async () => {
    handle = await createTestDb();
    const now = new Date();
    const oldClosedAt = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    await handle.db.insert(workItems).values({
      id: 'PROJ-2',
      category: 'fyi',
      urgency: 'low',
      jiraKey: 'PROJ-2',
      jira: { key: 'PROJ-2', project: 'PROJ', summary: 'Old merged thing', status: 'In Progress', statusCategory: 'In Progress', priority: 'Medium', updated: now.toISOString(), url: 'http://x/PROJ-2' },
      prs: [
        {
          repo: 'org/repo', number: 41, title: 'PROJ-2: old merged thing', url: 'http://x/pr/41',
          state: 'merged', isDraft: false, branch: 'work-agent/proj-2', isAuthor: true,
          reviewRequestedOfMe: false, reviewState: 'none', updatedAt: oldClosedAt, closedAt: oldClosedAt,
        },
      ],
      slackMessages: [],
      reasons: [],
      firstSeenAt: now,
      updatedAt: now,
    });
    const html = await renderDashboard(handle.db);
    // The ticket itself still legitimately shows elsewhere (Active work
    // items) — what matters here is specifically the "Recently merged"
    // panel's own count staying at 0, not the PR's title never appearing
    // anywhere on the page.
    expect(html).toContain('<h2>Recently merged</h2><span class="count">0</span>');
    expect(html).toContain('Nothing merged in the last 7 days.');
  });

  it('shows Start/Estimate buttons on a pending-approval card whose target is a real ticket key, not on one that is not', async () => {
    handle = await createTestDb();
    const store = new ApprovalsStore(handle.db);
    await store.file({
      id: 'start-pr:PROJ-1', source: 'observation', action: 'create_branch_or_pr', target: 'PROJ-1',
      context: {}, reasoning: 'x', riskLevel: 'low', consequenceIfApproved: 'x', recommendedAction: 'x',
    });
    await store.file({
      id: 'review:1', source: 'observation', action: 'review_pull_request', target: 'org/repo#1',
      context: {}, reasoning: 'x', riskLevel: 'low', consequenceIfApproved: 'x', recommendedAction: 'x',
    });
    const html = await renderDashboard(handle.db);
    expect(html).toContain('data-key="PROJ-1" data-action="estimate"');
    expect(html).toContain('data-key="PROJ-1" data-action="work"');
    expect(html).not.toContain('data-key="org/repo#1"');
  });
});
