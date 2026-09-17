import { describe, expect, it } from 'vitest';
import { buildLaunchCommand, isValidTicketKey } from '../../src/dashboard/launchSession.js';

describe('isValidTicketKey', () => {
  it('accepts real Jira issue key shapes', () => {
    expect(isValidTicketKey('QED42OPSIN-60')).toBe(true);
    expect(isValidTicketKey('PROJ-1')).toBe(true);
  });

  it('rejects anything else — this gets embedded into a shell command string', () => {
    expect(isValidTicketKey('')).toBe(false);
    expect(isValidTicketKey('not a key')).toBe(false);
    expect(isValidTicketKey('PROJ-1; rm -rf /')).toBe(false);
    expect(isValidTicketKey('PROJ-1" && echo pwned')).toBe(false);
    expect(isValidTicketKey('lowercase-1')).toBe(false);
  });
});

describe('buildLaunchCommand', () => {
  it('ubuntu: opens gnome-terminal running claude primed with the ticket, cd\'d into the work-agent dir', () => {
    const { bin, args } = buildLaunchCommand('ubuntu', '/home/me/work-agent', 'PROJ-1');
    expect(bin).toBe('gnome-terminal');
    const inner = args.join(' ');
    expect(inner).toContain("cd '/home/me/work-agent'");
    expect(inner).toContain("claude 'work on task PROJ-1'");
  });

  it('mac: opens Terminal.app via osascript with the same cd + claude command', () => {
    const { bin, args } = buildLaunchCommand('mac', '/Users/me/work-agent', 'PROJ-1');
    expect(bin).toBe('osascript');
    const script = args.join(' ');
    expect(script).toContain('Terminal');
    expect(script).toContain("cd '/Users/me/work-agent'");
    expect(script).toContain("claude 'work on task PROJ-1'");
  });

  it('windows: opens a new cmd window with the same cd + claude command', () => {
    const { bin, args } = buildLaunchCommand('windows', 'C:\\Users\\me\\work-agent', 'PROJ-1');
    expect(bin).toBe('cmd.exe');
    const inner = args.join(' ');
    expect(inner).toContain('C:\\Users\\me\\work-agent');
    expect(inner).toContain('claude "work on task PROJ-1"');
  });

  it('safely quotes a work-agent directory containing a space, on the shell-based OSes', () => {
    const { args } = buildLaunchCommand('ubuntu', "/home/me/work agent's dir", 'PROJ-1');
    expect(args.join(' ')).toContain("'/home/me/work agent'\\''s dir'");
  });

  it('refuses to build a command for a malformed ticket key, on every OS', () => {
    expect(() => buildLaunchCommand('ubuntu', '/x', 'not a key')).toThrow(/malformed/);
    expect(() => buildLaunchCommand('mac', '/x', "'; rm -rf ~; '")).toThrow(/malformed/);
    expect(() => buildLaunchCommand('windows', '/x', '')).toThrow(/malformed/);
  });
});
