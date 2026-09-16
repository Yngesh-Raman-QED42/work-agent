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
});
