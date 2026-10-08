import { describe, expect, it } from 'vitest';
import { buildImplementationPrompt } from '../../src/agents/engineeringExecution/prompt.js';
import type { TaskContext } from '../../src/agents/engineeringExecution/models.js';

function makeTask(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    key: 'PROJ-1',
    project: 'PROJ',
    summary: 'Fix a thing',
    description: 'A plain description.',
    issueType: 'Task',
    status: 'To Do',
    priority: 'Medium',
    url: 'http://x/PROJ-1',
    comments: [],
    ...overrides,
  };
}

describe('buildImplementationPrompt — plain ticket (no sub-tasks)', () => {
  it('reads as a single-ticket prompt, unchanged from before this feature existed', () => {
    const prompt = buildImplementationPrompt(makeTask(), '/tmp/wt');
    expect(prompt).toContain('You are implementing exactly one Jira ticket');
    expect(prompt).toContain('Ticket: PROJ-1 (Task, priority Medium)');
    expect(prompt).not.toContain('Story:');
    expect(prompt).not.toContain('sub-task');
  });
});

describe('buildImplementationPrompt — a story with sub-tasks', () => {
  const story = makeTask({
    key: 'QED42OPSIN-96',
    issueType: 'User Story',
    summary: 'Utilization dashboard',
    description: 'As a manager, I want a utilization dashboard.',
    subtasks: [
      makeTask({
        key: 'QED42OPSIN-101',
        issueType: 'Sub-task',
        summary: 'Add the utilization-by-week SQL query',
        description: 'Write the aggregation query.',
        comments: [{ author: 'Dev', body: 'started on this' }],
      }),
      makeTask({
        key: 'QED42OPSIN-102',
        issueType: 'Sub-task',
        summary: 'Expose GET /api/utilization',
        description: 'Add the REST endpoint.',
      }),
    ],
  });

  it('frames the whole group as one branch of work, not a single ticket', () => {
    const prompt = buildImplementationPrompt(story, '/tmp/wt');
    expect(prompt).toContain('You are implementing one Jira story — QED42OPSIN-96 — together with all 2 of its');
    expect(prompt).toContain('Story: QED42OPSIN-96 (User Story, priority Medium)');
    expect(prompt).not.toContain('Ticket: QED42OPSIN-96');
  });

  it('lists every sub-task with its own full summary, description, and comments', () => {
    const prompt = buildImplementationPrompt(story, '/tmp/wt');
    expect(prompt).toContain('Sub-task 1/2: QED42OPSIN-101 (Sub-task)');
    expect(prompt).toContain('Add the utilization-by-week SQL query');
    expect(prompt).toContain('Write the aggregation query.');
    expect(prompt).toContain('Dev: started on this');
    expect(prompt).toContain('Sub-task 2/2: QED42OPSIN-102 (Sub-task)');
    expect(prompt).toContain('Expose GET /api/utilization');
  });

  it('a sub-task with no comments still renders cleanly', () => {
    const prompt = buildImplementationPrompt(story, '/tmp/wt');
    expect(prompt).toMatch(/QED42OPSIN-102[\s\S]*\(no comments\)/);
  });
});
