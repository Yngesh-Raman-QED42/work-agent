import { run } from './shell.js';
import type { CheckResult } from './models.js';

export const DEFAULT_COMMANDS: Array<[string, string[]]> = [
  ['test', ['npm', 'test']],
  ['lint', ['npm', 'run', 'lint']],
  ['typecheck', ['npx', 'tsc', '--noEmit']],
  ['build', ['npm', 'run', 'build']],
];

const OUTPUT_TAIL_CHARS = 4000;
const RETRY_DELAY_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A real build can fail for reasons that have nothing to do with the
 * ticket's own change — e.g. `next/font/google` fetches font files from
 * Google Fonts at build time, and a transient DNS/network blip fails the
 * whole build with the same ETIMEDOUT/ENETUNREACH error a human re-running
 * it by hand a minute later never sees. Retrying here mirrors exactly
 * that: a handful of attempts, a short pause between them, and if any one
 * of them passes, the check passed — the ticket's code was never the
 * problem. Applies to every command uniformly rather than special-casing
 * "build" specifically, since lint/typecheck/test can just as plausibly
 * hit their own transient network blip (a registry fetch, a real API a
 * test happens to touch).
 */
export async function runChecks(
  worktreePath: string,
  commands: Array<[string, string[]]> = DEFAULT_COMMANDS,
  timeoutMs = 900_000,
  retries = 2,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const [name, cmd] of commands) {
    let result = await run(cmd, { cwd: worktreePath, timeoutMs });
    for (let attempt = 1; result.code !== 0 && attempt <= retries; attempt += 1) {
      await sleep(RETRY_DELAY_MS);
      result = await run(cmd, { cwd: worktreePath, timeoutMs });
    }
    const tail = result.output.length > OUTPUT_TAIL_CHARS ? result.output.slice(-OUTPUT_TAIL_CHARS) : result.output;
    results.push({ name, command: cmd.join(' '), passed: result.code === 0, output: tail });
  }
  return results;
}
