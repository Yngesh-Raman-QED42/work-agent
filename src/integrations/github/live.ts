import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitHubPr } from '../../models/types.js';
import type { GitHubConnector } from '../types.js';

const execFileAsync = promisify(execFile);

/**
 * Read-only, via the `gh` CLI rather than a raw REST+token client.
 *
 * This is a deliberate choice, not a shortcut: the GitHub MCP plugin's PAT is
 * scoped to personal repos only (confirmed by a 404 against the real org
 * repo during Phase 2's live run) while `gh` is already authenticated with
 * real org access on this machine. Using `gh` is what actually works here.
 */
export class LiveGitHubConnector implements GitHubConnector {
  /**
   * @param workRepos Optional "owner/repo" allowlist (e.g.
   * config.github.approvedRepos). `author:`/`review-requested:` search
   * across ALL of GitHub, not just work repos — without this, a personal
   * open-source contribution or side-project PR shows up identically to a
   * work PR needing attention. Omit to see everything (rarely what you
   * want for a work tracker).
   */
  constructor(private workRepos?: string[]) {}

  async fetchMyPullRequests(): Promise<GitHubPr[]> {
    const me = await this.currentUser();
    const byKey = new Map<string, GitHubPr>();

    const authored = await this.searchPrs(`author:${me}`);
    for (const pr of authored) {
      byKey.set(`${pr.repo}#${pr.number}`, { ...pr, isAuthor: true });
    }

    const reviewRequested = await this.searchPrs(`review-requested:${me}`);
    for (const pr of reviewRequested) {
      const key = `${pr.repo}#${pr.number}`;
      const existing = byKey.get(key);
      byKey.set(key, existing ? { ...existing, reviewRequestedOfMe: true } : { ...pr, reviewRequestedOfMe: true });
    }

    const all = [...byKey.values()];
    if (!this.workRepos || this.workRepos.length === 0) return all;
    const allowed = new Set(this.workRepos);
    return all.filter((pr) => allowed.has(pr.repo));
  }

  private async currentUser(): Promise<string> {
    const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login']);
    return stdout.trim();
  }

  /**
   * Deliberately a SINGLE-qualifier query. `gh search prs` in the version
   * installed here (2.45.0) has a real bug: combining more than one
   * qualifier (e.g. `author:X is:open`, in one string OR as separate argv
   * tokens) either errors ("Invalid search query") or silently returns
   * unfiltered/wrong-author results — confirmed by hand while debugging
   * this the first time it actually ran for real. A single qualifier
   * behaves correctly, so state filtering happens client-side below
   * instead of in the query.
   */
  private async searchPrs(query: string): Promise<GitHubPr[]> {
    const { stdout } = await execFileAsync('gh', [
      'search',
      'prs',
      query,
      '--json',
      'repository,number,title,url,state,isDraft,updatedAt',
      '--limit',
      '50',
    ]);
    const items = JSON.parse(stdout) as Array<{
      repository: { nameWithOwner: string };
      number: number;
      title: string;
      url: string;
      state: string;
      isDraft: boolean;
      updatedAt: string;
    }>;

    const open = items.filter((item) => item.state.toLowerCase() === 'open');

    // Fetch the branch name with one follow-up `gh pr view` call per result
    // (only for the ones we're keeping) — `gh search prs --json` doesn't
    // support `headRefName` at all; only `gh pr view`/`gh pr list` do.
    return Promise.all(
      open.map(async (item) => ({
        repo: item.repository.nameWithOwner,
        number: item.number,
        title: item.title,
        url: item.url,
        state: 'open' as const,
        isDraft: item.isDraft,
        branch: await this.fetchBranch(item.repository.nameWithOwner, item.number),
        isAuthor: false,
        reviewRequestedOfMe: false,
        reviewState: 'none' as const,
        updatedAt: item.updatedAt,
      })),
    );
  }

  private async fetchBranch(repo: string, number: number): Promise<string> {
    try {
      const { stdout } = await execFileAsync('gh', ['pr', 'view', String(number), '--repo', repo, '--json', 'headRefName']);
      return (JSON.parse(stdout) as { headRefName: string }).headRefName;
    } catch {
      return ''; // non-fatal — branch is used for Jira-key extraction, not required for anything else
    }
  }
}
