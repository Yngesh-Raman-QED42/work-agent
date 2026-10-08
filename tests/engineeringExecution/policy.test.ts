import { describe, expect, it } from 'vitest';
import { AutonomyPolicy } from '../../src/agents/engineeringExecution/policy.js';
import type { TaskContext } from '../../src/agents/engineeringExecution/models.js';

// These mirror the four real QED42OPSIN tickets this policy was validated
// against during the Python prototype (same redaction the real Jira data
// already had). Kept as regression fixtures so a future tweak can't
// silently re-admit the "do not start" or permissions tickets. Note these
// are content fixtures only — the policy itself has no project hardcoded;
// see selector.test.ts / config tests for that guarantee.

const CSS_OVERLAP_BUG: TaskContext = {
  key: 'QED42OPSIN-60',
  project: 'QED42OPSIN',
  summary: 'Capacity Planner | Fix Overlapping Allocation Labels in Frozen Panel During Scroll',
  description:
    'As a Capacity Planner user, I want allocation labels and project names to render correctly while ' +
    'scrolling so that I can clearly identify personnel and project allocations without UI overlap. ' +
    'Allocation bars and their labels should remain confined to the timeline/grid area and should not ' +
    'overlap the Personnel section.',
  issueType: 'Task',
  status: 'To Do',
  priority: 'Medium',
  url: 'http://x/QED42OPSIN-60',
  comments: [],
};

const SEARCH_BUG: TaskContext = {
  ...CSS_OVERLAP_BUG,
  key: 'QED42OPSIN-59',
  summary: 'Capacity Planner | Fix Capacity Planner Search Results',
  description:
    'Investigate and fix the Capacity Planner search functionality to ensure it accurately filters and ' +
    'displays data based on the entered search term. Should return matching personnel and projects and ' +
    'exclude unrelated ones from the results.',
};

const PERMISSION_BUG: TaskContext = {
  ...CSS_OVERLAP_BUG,
  key: 'QED42OPSIN-51',
  issueType: 'Bug',
  priority: 'Low',
  summary: 'Capacity Planner: "Create Allocations" permission on Project Manager role is not honoured',
  description:
    'Despite Create Allocations being enabled on the Project Manager role, the PM user was still unable ' +
    'to create allocations. The action only succeeded after granting full Admin rights. This suggests the ' +
    'allocation-creation permission check is not reading the role permission correctly.',
};

const ON_HOLD_TASK: TaskContext = {
  ...CSS_OVERLAP_BUG,
  key: 'QED42OPSIN-54',
  summary: 'Support per-user permission overrides on top of role-level permissions',
  description:
    'Support granting additional permissions to an individual user on top of their base role, so ' +
    'per-user exceptions do not require editing the shared role or escalating to Admin.',
  comments: [{ author: 'Anand Toshniwal', body: 'keep this one on hold.. do not start working on this one' }],
};

// Mirrors the real QED42OPSIN-96..123 case this feature was built for: a
// User Story whose own description is thin ("As a user...") but whose
// sub-tasks carry the real acceptance criteria — and one sub-task
// (QED42OPSIN-120) that's genuinely permission-related and must still
// block the whole story, not just itself.
const STORY_WITH_CLEAN_SUBTASKS: TaskContext = {
  key: 'QED42OPSIN-96',
  project: 'QED42OPSIN',
  summary: 'Utilization dashboard for the Capacity Planner',
  description: 'As a manager, I want a utilization dashboard.',
  issueType: 'User Story',
  status: 'To Do',
  priority: 'Medium',
  url: 'http://x/QED42OPSIN-96',
  comments: [],
  subtasks: [
    {
      key: 'QED42OPSIN-101',
      project: 'QED42OPSIN',
      summary: 'Add the utilization-by-week SQL query',
      description:
        'Write a query that aggregates logged hours per person per week for the current quarter, grouped by ' +
        'project, excluding time off and holidays from the denominator.',
      issueType: 'Sub-task',
      status: 'To Do',
      priority: 'Medium',
      url: 'http://x/QED42OPSIN-101',
      comments: [],
    },
    {
      key: 'QED42OPSIN-102',
      project: 'QED42OPSIN',
      summary: 'Expose GET /api/utilization',
      description: 'Add a REST endpoint returning the query above as JSON, paginated by team.',
      issueType: 'Sub-task',
      status: 'To Do',
      priority: 'Medium',
      url: 'http://x/QED42OPSIN-102',
      comments: [],
    },
  ],
};

const STORY_WITH_SENSITIVE_SUBTASK: TaskContext = {
  ...STORY_WITH_CLEAN_SUBTASKS,
  key: 'QED42OPSIN-100',
  summary: 'Access control, reconciliation and release',
  subtasks: [
    ...STORY_WITH_CLEAN_SUBTASKS.subtasks!,
    {
      key: 'QED42OPSIN-120',
      project: 'QED42OPSIN',
      summary: 'Permission check and role mapping for the utilization view',
      description:
        'Only managers and admins should see direct-report utilization; enforce this via a role-based ' +
        'permission check on the new endpoint, matching the existing RBAC scheme.',
      issueType: 'Sub-task',
      status: 'To Do',
      priority: 'Medium',
      url: 'http://x/QED42OPSIN-120',
      comments: [],
    },
  ],
};

describe('AutonomyPolicy — stories with sub-tasks', () => {
  const policy = new AutonomyPolicy();

  it('a "User Story" issue type is no longer rejected outright', () => {
    const result = policy.isEligible(STORY_WITH_CLEAN_SUBTASKS);
    expect(result.reasons.join(' ')).not.toMatch(/issue type .* is not eligible/);
  });

  it('a story with clean sub-tasks is eligible, even though its own description alone is short', () => {
    expect(STORY_WITH_CLEAN_SUBTASKS.description.trim().length).toBeLessThan(80); // short on its own
    const result = policy.isEligible(STORY_WITH_CLEAN_SUBTASKS);
    expect(result.eligible).toBe(true);
  });

  it('a story is excluded when ANY of its sub-tasks touches a sensitive area — not just its own text', () => {
    const result = policy.isEligible(STORY_WITH_SENSITIVE_SUBTASK);
    expect(result.eligible).toBe(false);
    expect(result.reasons[0]).toContain('sensitive');
    expect(result.reasons[0]).toContain('QED42OPSIN-120'); // names which sub-task, not just "somewhere"
  });

  it('a story is excluded when a sub-task (not the story itself) carries an explicit hold instruction', () => {
    const story = {
      ...STORY_WITH_CLEAN_SUBTASKS,
      subtasks: [
        { ...STORY_WITH_CLEAN_SUBTASKS.subtasks![0]!, comments: [{ author: 'PM', body: 'do not start this sub-task yet' }] },
      ],
    };
    const result = policy.isEligible(story);
    expect(result.eligible).toBe(false);
    expect(result.reasons[0]).toMatch(/hold instruction/);
    expect(result.reasons[0]).toContain(story.subtasks[0]!.key);
  });

  it('a plain Task with no subtasks field behaves exactly as before (no regression)', () => {
    const task: TaskContext = {
      key: 'PROJ-1', project: 'PROJ', summary: 'x', description: 'd'.repeat(200),
      issueType: 'Task', status: 'To Do', priority: 'Medium', url: 'http://x/PROJ-1', comments: [],
    };
    expect(policy.isEligible(task).eligible).toBe(true);
  });
});

describe('AutonomyPolicy', () => {
  const policy = new AutonomyPolicy();

  it('a well-scoped CSS bug is eligible', () => {
    expect(policy.isEligible(CSS_OVERLAP_BUG).eligible).toBe(true);
  });

  it('a well-scoped search bug is eligible', () => {
    expect(policy.isEligible(SEARCH_BUG).eligible).toBe(true);
  });

  it('a ticket touching permissions is excluded as sensitive', () => {
    const result = policy.isEligible(PERMISSION_BUG);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes('sensitive'))).toBe(true);
  });

  it('a ticket with an explicit hold comment is excluded', () => {
    const result = policy.isEligible(ON_HOLD_TASK);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.toLowerCase().includes('hold'))).toBe(true);
  });

  it('high and critical priority are eligible — urgency alone does not make a ticket unsafe', () => {
    expect(policy.isEligible({ ...CSS_OVERLAP_BUG, priority: 'High' }).eligible).toBe(true);
    expect(policy.isEligible({ ...CSS_OVERLAP_BUG, priority: 'Critical' }).eligible).toBe(true);
  });

  it('a made-up, non-standard priority value is still excluded — this is an allowlist, not "anything goes"', () => {
    const task = { ...CSS_OVERLAP_BUG, priority: 'Whenever' };
    expect(policy.isEligible(task).eligible).toBe(false);
  });

  it('an On Hold status is eligible on its own — only an explicit hold instruction in the text excludes it', () => {
    const task = { ...CSS_OVERLAP_BUG, status: 'On Hold' };
    expect(policy.isEligible(task).eligible).toBe(true);
  });

  it('epic issue type is excluded', () => {
    const task = { ...CSS_OVERLAP_BUG, issueType: 'Epic' };
    expect(policy.isEligible(task).eligible).toBe(false);
  });

  it('in-progress status is excluded (autonomy only picks up To Do)', () => {
    const task = { ...CSS_OVERLAP_BUG, status: 'In Progress' };
    expect(policy.isEligible(task).eligible).toBe(false);
  });

  it('a thin description is excluded', () => {
    const task = { ...CSS_OVERLAP_BUG, description: 'too short' };
    expect(policy.isEligible(task).eligible).toBe(false);
  });

  it('a blocking phrase inside the description itself is caught, not just comments', () => {
    const task = {
      ...CSS_OVERLAP_BUG,
      description: 'This needs doing eventually but please do not start until Q3. '.repeat(3),
    };
    expect(policy.isEligible(task).eligible).toBe(false);
  });

  it('an allowedProjects restriction excludes anything outside it', () => {
    const restricted = new AutonomyPolicy({ allowedProjects: new Set(['SOMEOTHERPROJ']) });
    expect(restricted.isEligible(CSS_OVERLAP_BUG).eligible).toBe(false);
  });

  it('with no allowedProjects restriction, any project passes that check', () => {
    const task = { ...CSS_OVERLAP_BUG, project: 'BRAND_NEW_PROJECT_NEVER_SEEN_BEFORE' };
    expect(policy.isEligible(task).eligible).toBe(true);
  });
});
