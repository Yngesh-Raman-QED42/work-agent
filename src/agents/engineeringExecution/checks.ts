import { run } from './shell.js';
import type { CheckResult } from './models.js';

export const DEFAULT_COMMANDS: Array<[string, string[]]> = [
  ['test', ['npm', 'test']],
  ['lint', ['npm', 'run', 'lint']],
  ['typecheck', ['npx', 'tsc', '--noEmit']],
  ['build', ['npm', 'run', 'build']],
];

const OUTPUT_TAIL_CHARS = 4000;

export async function runChecks(
  worktreePath: string,
  commands: Array<[string, string[]]> = DEFAULT_COMMANDS,
  timeoutMs = 900_000,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const [name, cmd] of commands) {
    const result = await run(cmd, { cwd: worktreePath, timeoutMs });
    const tail = result.output.length > OUTPUT_TAIL_CHARS ? result.output.slice(-OUTPUT_TAIL_CHARS) : result.output;
    results.push({ name, command: cmd.join(' '), passed: result.code === 0, output: tail });
  }
  return results;
}
