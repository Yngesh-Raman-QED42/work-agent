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

describe('buildImplementationPrompt — no Figma reference (the common case)', () => {
  it('omits the Figma block entirely — prompt reads identically to before this feature existed', () => {
    const prompt = buildImplementationPrompt(makeTask(), '/tmp/wt', null, []);
    expect(prompt).not.toContain('Figma');
    expect(prompt).not.toContain('pixel-perfect');
  });
});

describe('buildImplementationPrompt — with Figma design references', () => {
  it('lists a rendered reference by its own Figma frame name and points at the saved file in the worktree', () => {
    const prompt = buildImplementationPrompt(makeTask(), '/tmp/wt', null, [
      { url: 'https://figma.com/design/ABC/x?node-id=1-1', name: 'Homepage / Desktop', savedRelativePath: '.work-agent/figma-reference/figma-1-homepage-desktop.png' },
    ]);
    expect(prompt).toContain('This ticket has 1 linked Figma design reference(s)');
    expect(prompt).toContain('- Homepage / Desktop: https://figma.com/design/ABC/x?node-id=1-1');
    expect(prompt).toContain('.work-agent/figma-reference/figma-1-homepage-desktop.png');
  });

  it('lists desktop and mobile as two distinct, clearly labeled references', () => {
    const prompt = buildImplementationPrompt(makeTask(), '/tmp/wt', null, [
      { url: 'http://figma/d', name: 'Homepage / Desktop', savedRelativePath: '.work-agent/figma-reference/figma-1-desktop.png' },
      { url: 'http://figma/m', name: 'Homepage / Mobile', savedRelativePath: '.work-agent/figma-reference/figma-2-mobile.png' },
    ]);
    expect(prompt).toContain('This ticket has 2 linked Figma design reference(s)');
    expect(prompt).toContain('Homepage / Desktop');
    expect(prompt).toContain('Homepage / Mobile');
  });

  it('a reference with no saved image falls back to telling the implementer to open the link directly', () => {
    const prompt = buildImplementationPrompt(makeTask(), '/tmp/wt', null, [{ url: 'https://figma.com/file/ABC/x' }]);
    expect(prompt).toContain('design reference 1: https://figma.com/file/ABC/x');
    expect(prompt).toContain('No pre-rendered image is available');
  });

  it('explicitly says pixel-perfect means matching the render, not hardcoding values — and to reuse this project\'s own tokens/components', () => {
    const prompt = buildImplementationPrompt(makeTask(), '/tmp/wt', null, [{ url: 'http://x', name: 'Frame' }]);
    expect(prompt).toMatch(/does NOT mean hardcoding literal pixel values/);
    expect(prompt).toMatch(/existing design-token\/component layer/);
    expect(prompt).toMatch(/reusing or extending what's already there/);
  });

  it('frames a Figma reference on a story as covering the whole story, not just "ticket"', () => {
    const story = makeTask({ subtasks: [makeTask({ key: 'PROJ-2' })] });
    const prompt = buildImplementationPrompt(story, '/tmp/wt', null, [{ url: 'http://x', name: 'Frame' }]);
    expect(prompt).toContain('This story has 1 linked Figma design reference(s)');
  });
});
