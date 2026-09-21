import { describe, expect, it } from 'vitest';
import { buildLaunchCommand, buildResolveConflictCommand, isValidTicketKey } from '../../src/dashboard/launchSession.js';

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

  it('defaults to the "work" action when none is given', () => {
    const withDefault = buildLaunchCommand('ubuntu', '/x', 'PROJ-1');
    const withExplicit = buildLaunchCommand('ubuntu', '/x', 'PROJ-1', 'work');
    expect(withDefault).toEqual(withExplicit);
  });

  it('"estimate" action asks for a read-only estimate, never an implementation', () => {
    const { args } = buildLaunchCommand('ubuntu', '/x', 'PROJ-1', 'estimate');
    const inner = args.join(' ');
    expect(inner).toContain('estimate task PROJ-1');
    expect(inner).toContain('read-only');
    expect(inner).toMatch(/do not write any code, create a branch, open a PR/);
    expect(inner).toContain('generous buffer');
  });

  it('"estimate" action asks for an AI-assisted estimate, not manual human-coding time', () => {
    const { args } = buildLaunchCommand('ubuntu', '/x', 'PROJ-1', 'estimate');
    const inner = args.join(' ');
    expect(inner).toMatch(/AI-assisted/);
    expect(inner).toMatch(/not manual line-by-line human coding/);
    expect(inner).toContain('exec-start/exec-finish');
  });

  it('"estimate" action still validates the ticket key before building anything', () => {
    expect(() => buildLaunchCommand('ubuntu', '/x', 'not a key', 'estimate')).toThrow(/malformed/);
  });
});

describe('buildResolveConflictCommand', () => {
  const pr = { repo: 'org/repo', number: 56, title: 'feat(sync): add a thing', branch: 'feat/thing' };

  it('ubuntu: opens gnome-terminal with a prompt naming the exact PR, its branch, and never to merge it', () => {
    const { bin, args } = buildResolveConflictCommand('ubuntu', '/home/me/work-agent', pr);
    expect(bin).toBe('gnome-terminal');
    const inner = args.join(' ');
    expect(inner).toContain("cd '/home/me/work-agent'");
    expect(inner).toContain('resolve the merge conflict on PR org/repo#56');
    expect(inner).toContain('feat(sync): add a thing');
    expect(inner).toContain('branch feat/thing');
    expect(inner).toMatch(/Do not merge the PR itself/);
  });

  it('mac and windows build the same prompt through their own terminal mechanics', () => {
    const mac = buildResolveConflictCommand('mac', '/Users/me/work-agent', pr);
    expect(mac.bin).toBe('osascript');
    expect(mac.args.join(' ')).toContain('resolve the merge conflict on PR org/repo#56');

    const win = buildResolveConflictCommand('windows', 'C:\\Users\\me\\work-agent', pr);
    expect(win.bin).toBe('cmd.exe');
    expect(win.args.join(' ')).toContain('resolve the merge conflict on PR org/repo#56');
  });

  it('refuses a malformed repo or a non-positive PR number', () => {
    expect(() => buildResolveConflictCommand('ubuntu', '/x', { ...pr, repo: 'not-a-repo' })).toThrow(/malformed/);
    expect(() => buildResolveConflictCommand('ubuntu', '/x', { ...pr, repo: "org/repo'; rm -rf ~; '" })).toThrow(/malformed/);
    expect(() => buildResolveConflictCommand('ubuntu', '/x', { ...pr, number: 0 })).toThrow(/malformed/);
    expect(() => buildResolveConflictCommand('ubuntu', '/x', { ...pr, number: -1 })).toThrow(/malformed/);
  });
});
