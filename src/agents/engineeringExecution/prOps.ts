import { runOrThrow } from './shell.js';
import type { RepoInfo } from './models.js';
import { repoFullName } from './models.js';

/** No implementation of this may ever merge a PR — creation only, and
 * always as a draft. */
export interface PullRequestCreator {
  createDraftPr(repo: RepoInfo, branch: string, title: string, body: string): Promise<string>;
}

/** Uses the `gh` CLI (already authenticated with real org access in this
 * environment — the GitHub MCP plugin's PAT is scoped to personal repos
 * only, confirmed during Phase 2's first live run). Always passes --draft;
 * never calls `gh pr merge`. */
export class GhCliPullRequestCreator implements PullRequestCreator {
  async createDraftPr(repo: RepoInfo, branch: string, title: string, body: string): Promise<string> {
    const cmd = [
      'gh', 'pr', 'create',
      '--repo', repoFullName(repo),
      '--head', branch,
      '--base', repo.defaultBranch,
      '--draft',
      '--title', title,
      '--body', body,
    ];
    const result = await runOrThrow(cmd, { cwd: repo.localPath, timeoutMs: 120_000 });
    const lines = result.output.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.at(-1) ?? '';
  }
}

export class MockPullRequestCreator implements PullRequestCreator {
  calls: Array<{ repo: string; branch: string; title: string; body: string }> = [];

  async createDraftPr(repo: RepoInfo, branch: string, title: string, body: string): Promise<string> {
    this.calls.push({ repo: repoFullName(repo), branch, title, body });
    return `https://github.com/${repoFullName(repo)}/pull/999`;
  }
}
