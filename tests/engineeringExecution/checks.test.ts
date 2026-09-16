import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecks } from '../../src/agents/engineeringExecution/checks.js';

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A command that fails on its first `failures` invocations (tracked via a
 * counter file, since each attempt is a fresh process) and succeeds after —
 * stands in for a real transient failure like a font-fetch timeout during
 * `next build`, without depending on real network flakiness in a test. */
function flakyScript(counterFile: string, failures: number): string {
  return (
    `const fs=require('fs');let n=0;try{n=Number(fs.readFileSync(${JSON.stringify(counterFile)},'utf-8'))}catch{}` +
    `n+=1;fs.writeFileSync(${JSON.stringify(counterFile)},String(n));process.exit(n>${failures}?0:1);`
  );
}

function makeCounterFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'checks-retry-'));
  cleanupDirs.push(dir);
  return join(dir, 'count');
}

describe('runChecks retrying transient failures', () => {
  it('passes once a later attempt succeeds, within the retry budget', async () => {
    const counterFile = makeCounterFile();
    const results = await runChecks('.', [['flaky', ['node', '-e', flakyScript(counterFile, 2)]]], 60_000, 2);
    expect(results[0]!.passed).toBe(true);
    expect(readFileSync(counterFile, 'utf-8')).toBe('3'); // failed twice, passed on the 3rd attempt
  }, 20_000);

  it('reports failed once every attempt in the retry budget fails — a real failure still fails', async () => {
    const counterFile = makeCounterFile();
    const results = await runChecks('.', [['always-fails', ['node', '-e', flakyScript(counterFile, 99)]]], 60_000, 1);
    expect(results[0]!.passed).toBe(false);
    expect(readFileSync(counterFile, 'utf-8')).toBe('2'); // 1 initial attempt + 1 retry
  }, 20_000);

  it('retries: 0 means exactly one attempt, no retry at all', async () => {
    const counterFile = makeCounterFile();
    const results = await runChecks('.', [['flaky', ['node', '-e', flakyScript(counterFile, 2)]]], 60_000, 0);
    expect(results[0]!.passed).toBe(false);
    expect(readFileSync(counterFile, 'utf-8')).toBe('1');
  }, 20_000);
});
