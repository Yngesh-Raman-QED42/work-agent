import { describe, expect, it } from 'vitest';
import { evaluateCandidates, selectTask } from '../../src/agents/engineeringExecution/selector.js';
import { AutonomyPolicy } from '../../src/agents/engineeringExecution/policy.js';
import type { TaskContext } from '../../src/agents/engineeringExecution/models.js';

function makeTask(key: string, overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    key,
    project: 'ANYPROJ',
    summary: `summary ${key}`,
    description: 'd'.repeat(100),
    issueType: 'Task',
    status: 'To Do',
    priority: 'Medium',
    url: `http://x/${key}`,
    comments: [],
    ...overrides,
  };
}

describe('selectTask', () => {
  const policy = new AutonomyPolicy();

  it('picks the smallest eligible description', () => {
    const small = makeTask('A-1', { description: 'd'.repeat(100) });
    const big = makeTask('A-2', { description: 'd'.repeat(500) });
    expect(selectTask([big, small], policy).picked?.key).toBe('A-1');
  });

  it('skips ineligible candidates', () => {
    const ineligible = makeTask('A-1', { issueType: 'Epic' });
    const eligible = makeTask('A-2');
    expect(selectTask([ineligible, eligible], policy).picked?.key).toBe('A-2');
  });

  it('returns null when nothing is eligible', () => {
    const ineligible = makeTask('A-1', { issueType: 'Epic' });
    expect(selectTask([ineligible], policy).picked).toBeNull();
  });

  it('excludes a candidate with an existing PR', () => {
    const task = makeTask('A-1');
    const result = selectTask([task], policy, (key) => key === 'A-1');
    expect(result.picked).toBeNull();
  });

  it('fewer enumerated requirements wins even with a shorter raw description elsewhere', () => {
    // Regression test for a real selection the live Python run got wrong: a
    // short paraphrase with 5 bullet requirements must NOT beat a longer
    // single-requirement description just because it has fewer raw chars.
    const manyRequirements = makeTask('A-1', {
      description:
        'Fix search.\n' +
        '* Return matching personnel.\n' +
        '* Return matching projects.\n' +
        '* Display only relevant allocations.\n' +
        '* Exclude unrelated results.\n' +
        '* Maintain accuracy across filters.\n',
    });
    const oneRequirement = makeTask('A-2', {
      description:
        'As a user I want allocation labels to render correctly while scrolling so that personnel and ' +
        'project details are not obscured. Requirement: allocation bars and labels should remain confined ' +
        'to the grid area and never overlap the frozen panel.',
    });
    expect(selectTask([manyRequirements, oneRequirement], policy).picked?.key).toBe('A-2');
  });

  it('evaluateCandidates reports every candidate, including losers', () => {
    const small = makeTask('A-1');
    const big = makeTask('A-2', { description: 'd'.repeat(500) });
    const evaluations = evaluateCandidates([small, big], policy);
    expect(evaluations).toHaveLength(2);
    expect(evaluations.every((e) => e.eligible)).toBe(true);
  });

  it('marks a duplicate PR exclusion distinctly', () => {
    const task = makeTask('A-1');
    const evaluations = evaluateCandidates([task], policy, () => true);
    expect(evaluations[0]!.eligible).toBe(false);
    expect(evaluations[0]!.excludedDuplicate).toBe(true);
  });

  it('works across an arbitrary variety of project keys in one candidate list (no project hardcoded anywhere)', () => {
    const tasks = [makeTask('ALPHA-1', { project: 'ALPHA' }), makeTask('BETA-1', { project: 'BETA' }), makeTask('GAMMA-1', { project: 'GAMMA' })];
    const result = selectTask(tasks, policy);
    expect(result.picked).not.toBeNull();
    expect(evaluateCandidates(tasks, policy).every((e) => e.eligible)).toBe(true);
  });
});
