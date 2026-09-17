// Builds the OS-specific command for the dashboard's "Start" button: open a
// real terminal on your own machine, cd into the work-agent repo itself,
// and start a real, interactive `claude` session already primed with the
// instruction to work on a specific ticket — exactly what you'd type by
// hand (see CLAUDE.md). This is NOT the unattended/headless agent path
// (that's blocked by this environment's own safety classifier) — a real
// terminal window with a real interactive session opens, no different from
// typing the commands yourself.

export type TerminalOs = 'ubuntu' | 'mac' | 'windows';

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

/**
 * Builds the command to open a terminal, cd into `workAgentDir`, and run
 * `claude "work on task <ticketKey>"` — Claude Code's CLI accepts an
 * initial prompt as an argument, so the session opens already primed with
 * the instruction rather than sitting empty waiting for it to be typed.
 */
export function buildLaunchCommand(os: TerminalOs, workAgentDir: string, ticketKey: string): LaunchCommand {
  if (!isValidTicketKey(ticketKey)) {
    throw new Error(`refusing to build a launch command for a malformed ticket key: ${ticketKey}`);
  }
  const prompt = `work on task ${ticketKey}`;

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
