import { spawn } from 'node:child_process';

export interface CommandResult {
  command: string;
  code: number;
  output: string;
}

export function run(cmd: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}): Promise<CommandResult> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  return new Promise((resolve) => {
    const [bin, ...args] = cmd;
    const child = spawn(bin!, args, { cwd: opts.cwd });
    let output = '';
    let settled = false;

    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ command: cmd.join(' '), code: 124, output: output + `\n[timed out after ${timeoutMs}ms]` });
    }, timeoutMs);

    child.stdout?.on('data', (d) => (output += d.toString()));
    child.stderr?.on('data', (d) => (output += d.toString()));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command: cmd.join(' '), code: code ?? 1, output });
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command: cmd.join(' '), code: 1, output: output + `\n${String(err)}` });
    });
  });
}

export async function runOrThrow(cmd: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}): Promise<CommandResult> {
  const result = await run(cmd, opts);
  if (result.code !== 0) {
    throw new Error(`command failed (${result.command}):\n${result.output.slice(-2000)}`);
  }
  return result;
}
