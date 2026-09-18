import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitHubPr } from '../../models/types.js';
import type { GitHubConnector } from '../types.js';

const execFileAsync = promisify(execFile);

// Bounds how far back a merged PR is still fetched at all — generous
// relative to the dashboard's own 7-day "Recently merged" display window
// (see render.ts), so a pipeline run that's fallen behind by a few days
// still has the data once it catches up, without "merged" meaning
// "matches an author search, ever."
const MERGED_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

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
      'repository,number,title,url,state,isDraft,updatedAt,closedAt',
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
      closedAt: string | null;
    }>;

    // Open PRs always kept. Merged PRs kept too — but only recently merged
    // ones (see MERGED_LOOKBACK_MS): without this, "merged" would mean
    // "matches an author search, ever," which grows unbounded over the
    // life of the project. A plain "closed" (declined without merging) is
    // dropped entirely; there's nothing actionable left to track once
    // that's happened and it isn't "recently merged" either.
    const relevant = items.filter((item) => {
      const state = item.state.toLowerCase();
      if (state === 'open') return true;
      if (state === 'merged' && item.closedAt) {
        return Date.now() - new Date(item.closedAt).getTime() <= MERGED_LOOKBACK_MS;
      }
      return false;
    });

    // Fetch the branch name with one follow-up `gh pr view` call per result
    // (only for the ones we're keeping) — `gh search prs --json` doesn't
    // support `headRefName` at all; only `gh pr view`/`gh pr list` do.
    return Promise.all(
      relevant.map(async (item) => ({
        repo: item.repository.nameWithOwner,
        number: item.number,
        title: item.title,
        url: item.url,
        state: item.state.toLowerCase() as 'open' | 'merged',
        isDraft: item.isDraft,
        branch: await this.fetchBranch(item.repository.nameWithOwner, item.number),
        isAuthor: false,
        reviewRequestedOfMe: false,
        reviewState: 'none' as const,
        updatedAt: item.updatedAt,
        closedAt: item.closedAt ?? undefined,
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
