import { run, type CommandResult } from './shell.js';

/**
 * Some frontend repos need a backend running locally (e.g. a headless CMS in
 * Docker) to fetch real data. `github.backendSync["owner/repo"]` in
 * work-agent.config.json names the one command that brings that backend up
 * to date — pull the latest backend code, (re)start its containers, apply
 * migrations/config — and exec-start runs it before every new task, so work
 * never starts against a stale or stopped backend.
 *
 * The command is entirely the repo owner's choice (a script, `make`,
 * `docker compose ...`); nothing here knows or guesses what the backend is.
 * Repos without an entry are unaffected.
 */
export interface BackendSyncRecipe {
  command: string[];
  cwd?: string;
  timeoutMs: number;
  /** "warn": report the failure and continue the task; "stop": don't start the task. */
  onFailure: 'warn' | 'stop';
  description?: string;
}

export type BackendSyncRunner = (cmd: string[], opts: { cwd?: string; timeoutMs?: number }) => Promise<CommandResult>;

export interface BackendSyncResult {
  ok: boolean;
  /** Last lines of the command's output, for the progress report and audit log. */
  outputTail: string;
  durationMs: number;
}

const TAIL_LINES = 15;

export async function runBackendSync(recipe: BackendSyncRecipe, runner: BackendSyncRunner = run): Promise<BackendSyncResult> {
  const started = Date.now();
  const result = await runner(recipe.command, { cwd: recipe.cwd, timeoutMs: recipe.timeoutMs });
  const outputTail = result.output.trim().split('\n').slice(-TAIL_LINES).join('\n');
  return { ok: result.code === 0, outputTail, durationMs: Date.now() - started };
}
