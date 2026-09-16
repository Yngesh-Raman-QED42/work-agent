// TaskContext/JiraComment live in integrations/jira/detail.ts — Task
// Intelligence needs the same shape to hand a task to this agent, so it's
// shared rather than duplicated. Re-exported here so existing imports keep
// working.
import type { TaskContext } from '../../integrations/jira/detail.js';
export type { JiraComment, TaskContext } from '../../integrations/jira/detail.js';
export { taskFullText } from '../../integrations/jira/detail.js';

export interface RepoInfo {
  projectKey: string;
  owner: string;
  repo: string;
  localPath: string;
  defaultBranch: string;
}

export function repoFullName(repo: RepoInfo): string {
  return `${repo.owner}/${repo.repo}`;
}

export interface CheckResult {
  name: string; // "test" | "lint" | "typecheck" | "build"
  command: string;
  passed: boolean;
  output: string;
}

export interface GateDecision {
  proceed: boolean;
  reasons: string[];
}

export type ExecutionStatus =
  | 'opened_pr'
  | 'stopped_ambiguous'
  | 'stopped_failed_checks'
  | 'no_eligible_task';

export interface ExecutionResult {
  status: ExecutionStatus;
  task?: TaskContext;
  branch?: string;
  prUrl?: string;
  checks: CheckResult[];
  reasons: string[];
  diffStat?: string;
  worktreePath?: string;
  screenshots?: import('./screenshot.js').CapturedScreenshot[];
  gifPath?: string;
  // Set only when screenshot capture was attempted and failed — never
  // blocks the PR, but must not be silently invisible either (see cli.ts).
  screenshotError?: string;
}
