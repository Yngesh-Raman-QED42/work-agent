// Builds the OS-specific command for the dashboard's ticket-card buttons:
// open a real terminal on your own machine, cd into the work-agent repo
// itself, and start a real, interactive `claude` session already primed
// with an instruction about a specific ticket — exactly what you'd type
// by hand (see CLAUDE.md). This is NOT the unattended/headless agent path
// (that's blocked by this environment's own safety classifier) — a real
// terminal window with a real interactive session opens, no different from
// typing the commands yourself.

export type TerminalOs = 'ubuntu' | 'mac' | 'windows';

// What the live session gets asked to do once it opens — CLAUDE.md is what
// actually defines the real behavior for each of these; this just supplies
// the one-line prompt that gets it there. Kept as a closed set (not a raw
// caller-supplied string) so every prompt this ever sends is one we wrote
// ourselves, never anything built from unvalidated input beyond the key.
export type SessionAction = 'work' | 'estimate';

const ACTION_PROMPTS: Record<SessionAction, (key: string) => string> = {
  work: (key) => `work on task ${key}`,
  // Deliberately explicit about what NOT to do — a fresh session reading
  // this cold has no other signal that "estimate" means read-only, unlike
  // "work on task" which CLAUDE.md already scopes tightly.
  estimate: (key) =>
    `estimate task ${key} — read-only, do not write any code, create a branch, open a PR, or ` +
    `log/comment anywhere. This will be implemented AI-assisted (Work Agent's own exec-start/` +
    `exec-finish flow — AI does the implementation, checks/gate run automatically), not manual ` +
    `line-by-line human coding, so calibrate the development portion to that. Give me a full time ` +
    `estimate covering the whole lifecycle (AI-assisted development, your review, QA, deployment), ` +
    `with a generous buffer on top, based on the ticket's actual requirements, any linked/sub-tasks, ` +
    `and dependencies on other services.`,
};

// Real Jira issue keys only (PROJECT-123) — this gets embedded into a
// shell/AppleScript/cmd command string below, so validating the shape
// up front (rather than trusting arbitrary input) matters regardless of
// how unlikely a malformed key is in practice.
const TICKET_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;

export function isValidTicketKey(key: string): boolean {
  return TICKET_KEY_RE.test(key);
}

export interface LaunchCommand {
  bin: string;
  args: string[];
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function appleScriptQuote(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Shared by every "open a terminal with this exact prompt" builder below —
 * the OS-specific mechanics are identical regardless of what's being asked;
 * only the prompt text differs. */
function buildCommandForPrompt(os: TerminalOs, workAgentDir: string, prompt: string): LaunchCommand {
  switch (os) {
    case 'mac': {
      const shellCmd = `cd ${shQuote(workAgentDir)} && claude ${shQuote(prompt)}`;
      const script = `tell application "Terminal" to do script "${appleScriptQuote(shellCmd)}"`;
      return { bin: 'osascript', args: ['-e', script] };
    }
    case 'windows': {
      // Best-effort — not verified against a real Windows machine (this
      // project runs on Linux/macOS in practice). `start "" cmd /k ...`
      // opens a new console window and leaves it open after `claude` exits.
      const inner = `cd /d "${workAgentDir}" && claude "${prompt}"`;
      return { bin: 'cmd.exe', args: ['/c', 'start', '""', 'cmd', '/k', inner] };
    }
    case 'ubuntu':
    default: {
      // `exec bash` after claude exits so the window stays open (matching
      // what actually happens when you run this by hand) instead of the
      // terminal just vanishing the moment the session ends.
      const inner = `cd ${shQuote(workAgentDir)} && claude ${shQuote(prompt)}; exec bash`;
      return { bin: 'gnome-terminal', args: ['--', 'bash', '-c', inner] };
    }
  }
}

/**
 * Builds the command to open a terminal, cd into `workAgentDir`, and run
 * `claude "<prompt for this action and ticket>"` — Claude Code's CLI
 * accepts an initial prompt as an argument, so the session opens already
 * primed with the instruction rather than sitting empty waiting for it.
 */
export function buildLaunchCommand(os: TerminalOs, workAgentDir: string, ticketKey: string, action: SessionAction = 'work'): LaunchCommand {
  if (!isValidTicketKey(ticketKey)) {
    throw new Error(`refusing to build a launch command for a malformed ticket key: ${ticketKey}`);
  }
  return buildCommandForPrompt(os, workAgentDir, ACTION_PROMPTS[action](ticketKey));
}

// "owner/repo" only — this gets embedded into a shell/AppleScript/cmd
// command string below, same reasoning as TICKET_KEY_RE.
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export interface ConflictedPrRef {
  repo: string;
  number: number;
  title: string;
  branch: string;
}

/**
 * A standalone open PR (no matching Jira ticket — see correlate.ts) isn't
 * a "task" the way a ticket is, so it doesn't get the general work/estimate
 * treatment. A merge conflict is the one thing on a PR card that's
 * unambiguously actionable and PR-specific, so it gets its own narrow
 * command instead of being folded into buildLaunchCommand's ticket-shaped
 * prompts.
 */
export function buildResolveConflictCommand(os: TerminalOs, workAgentDir: string, pr: ConflictedPrRef): LaunchCommand {
  if (!REPO_RE.test(pr.repo) || !Number.isInteger(pr.number) || pr.number <= 0) {
    throw new Error(`refusing to build a launch command for a malformed PR reference: ${pr.repo}#${pr.number}`);
  }
  const prompt =
    `resolve the merge conflict on PR ${pr.repo}#${pr.number} — ${pr.title} (branch ${pr.branch}). ` +
    `Check out its branch, merge in the latest base branch, resolve the conflicts, verify the repo's ` +
    `own tests/lint/build still pass, then push the fix to the same branch. Do not merge the PR itself.`;
  return buildCommandForPrompt(os, workAgentDir, prompt);
}
