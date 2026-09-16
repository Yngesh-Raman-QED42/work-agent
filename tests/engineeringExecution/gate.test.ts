import { describe, expect, it } from 'vitest';
import { evaluateGate, parseChangedFiles, DEFAULT_GATE_CONFIG } from '../../src/agents/engineeringExecution/gate.js';
import type { CheckResult } from '../../src/agents/engineeringExecution/models.js';

const PASSING: CheckResult[] = [
  { name: 'test', command: 'npm test', passed: true, output: '' },
  { name: 'lint', command: 'npm run lint', passed: true, output: '' },
];
const FAILING: CheckResult[] = [
  { name: 'test', command: 'npm test', passed: false, output: '1 failing' },
  { name: 'lint', command: 'npm run lint', passed: true, output: '' },
];
const SMALL_DIFF = ' src/components/planner/AllocationBar.tsx | 8 +++++---\n 1 file changed, 5 insertions(+), 3 deletions(-)';

describe('parseChangedFiles', () => {
  it('parses file names', () => {
    expect(parseChangedFiles(SMALL_DIFF)).toEqual(['src/components/planner/AllocationBar.tsx']);
  });

  it('returns none for an empty diff', () => {
    expect(parseChangedFiles('')).toEqual([]);
  });
});

describe('evaluateGate', () => {
  it('proceeds on passing checks and a small clean diff', () => {
    expect(evaluateGate(PASSING, SMALL_DIFF).proceed).toBe(true);
  });

  it('blocks on a failing check', () => {
    const decision = evaluateGate(FAILING, SMALL_DIFF);
    expect(decision.proceed).toBe(false);
    expect(decision.reasons.some((r) => r.includes('test'))).toBe(true);
  });

  it('blocks on an empty diff', () => {
    expect(evaluateGate(PASSING, '').proceed).toBe(false);
  });

  it('blocks on too many changed files', () => {
    const diff = Array.from({ length: 20 }, (_, i) => ` src/file${i}.ts | 1 +`).join('\n');
    const decision = evaluateGate(PASSING, diff, { ...DEFAULT_GATE_CONFIG, maxChangedFiles: 15 });
    expect(decision.proceed).toBe(false);
    expect(decision.reasons.some((r) => r.includes('exceeding'))).toBe(true);
  });

  it('blocks on a forbidden CI config path', () => {
    const diff = ' .github/workflows/ci.yml | 3 +--\n 1 file changed';
    expect(evaluateGate(PASSING, diff).proceed).toBe(false);
  });

  it('blocks on a lockfile change', () => {
    const diff = ' package-lock.json | 40 +++++++++++-----\n 1 file changed';
    expect(evaluateGate(PASSING, diff).proceed).toBe(false);
  });

  it('blocks on an env file change', () => {
    const diff = ' .env.production | 1 +\n 1 file changed';
    expect(evaluateGate(PASSING, diff).proceed).toBe(false);
  });
});
