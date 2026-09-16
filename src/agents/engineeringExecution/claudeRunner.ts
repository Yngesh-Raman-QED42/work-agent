export interface RunOutcome {
  success: boolean;
  summary: string;
}

/**
 * Implements "start Claude Code against the worktree, give it the task,
 * require it to inspect before modifying."
 *
 * IMPORTANT: there is deliberately no unattended-subprocess "Live"
 * implementation of this. Spawning `claude -p ... --permission-mode
 * bypassPermissions` was tried during the Python prototype's first live run
 * and blocked by this environment's own safety classifier — an agent with
 * all permission checks bypassed is exactly the pattern it exists to catch.
 * The correct live implementation is for the ORCHESTRATING Claude Code
 * session itself to spawn a properly-permissioned subagent (its `Agent`
 * tool) scoped to the worktree directory, so every file edit and shell
 * command the implementer runs stays subject to the same permission system
 * governing the orchestrating session. That's why `runExecution` takes an
 * injected `ClaudeCodeRunner` rather than constructing one — the live case
 * is provided by the calling session, not by this module.
 */
export interface ClaudeCodeRunner {
  run(worktreePath: string, prompt: string): Promise<RunOutcome>;
}

export class MockClaudeCodeRunner implements ClaudeCodeRunner {
  calls: Array<{ worktreePath: string; prompt: string }> = [];

  constructor(
    private outcome: RunOutcome = { success: true, summary: 'mock implementation complete' },
    private writeFile?: { relPath: string; content: string },
  ) {}

  async run(worktreePath: string, prompt: string): Promise<RunOutcome> {
    this.calls.push({ worktreePath, prompt });
    if (this.writeFile) {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { dirname, join } = await import('node:path');
      const fullPath = join(worktreePath, this.writeFile.relPath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, this.writeFile.content);
    }
    return this.outcome;
  }
}
