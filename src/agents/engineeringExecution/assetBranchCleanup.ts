import { run } from './shell.js';

/**
 * PR screenshots live on standalone "asset" branches (see gitOps.ts
 * publishAssetBranch): never part of the PR's diff, linked from the PR
 * description via github.com/<repo>/raw/<branch>/<file>. Once the PR they
 * illustrate is merged or closed they are just clutter (and on repos that
 * build every branch, e.g. Cloudflare Workers Builds, they trigger useless
 * builds), so they are removed automatically.
 *
 * Deliberately conservative:
 *  - only branches under ASSET_BRANCH_PREFIXES are ever considered;
 *  - a branch is deleted only when at least one PR links to its images AND
 *    every PR that does is merged or closed;
 *  - a branch no PR links to is left alone (we can't tell what it's for).
 */
export const ASSET_BRANCH_PREFIXES = ['work-agent/screenshots/', 'pr-assets/'];

export type PrState = 'OPEN' | 'CLOSED' | 'MERGED';

export interface AssetBranchGitHub {
  listBranches(repo: string, prefix: string): Promise<string[]>;
  /** Recent PRs (any state) with their descriptions. */
  listPrs(repo: string): Promise<Array<{ number: number; state: PrState; body: string }>>;
  deleteBranch(repo: string, branch: string): Promise<void>;
}

export interface AssetBranchDecision {
  repo: string;
  branch: string;
  action: 'deleted' | 'kept' | 'failed';
  reason: string;
}

const isAssetBranch = (branch: string) => ASSET_BRANCH_PREFIXES.some((p) => branch.startsWith(p) && branch.length > p.length);

export async function cleanupAssetBranches(repos: string[], github: AssetBranchGitHub): Promise<AssetBranchDecision[]> {
  const decisions: AssetBranchDecision[] = [];
  for (const repo of repos) {
    const branches = (await Promise.all(ASSET_BRANCH_PREFIXES.map((p) => github.listBranches(repo, p)))).flat().filter(isAssetBranch);
    if (branches.length === 0) continue;
    const prs = await github.listPrs(repo);

    for (const branch of branches) {
      const linking = prs.filter((pr) => pr.body.includes(`/raw/${branch}/`));
      if (linking.length === 0) {
        decisions.push({ repo, branch, action: 'kept', reason: 'no PR links to it' });
        continue;
      }
      const open = linking.filter((pr) => pr.state === 'OPEN');
      if (open.length > 0) {
        decisions.push({ repo, branch, action: 'kept', reason: `PR #${open.map((p) => p.number).join(', #')} still open` });
        continue;
      }
      const done = linking.map((p) => `#${p.number} ${p.state.toLowerCase()}`).join(', ');
      try {
        await github.deleteBranch(repo, branch);
        decisions.push({ repo, branch, action: 'deleted', reason: `PR ${done}` });
      } catch (err) {
        decisions.push({ repo, branch, action: 'failed', reason: String(err).split('\n')[0] ?? String(err) });
      }
    }
  }
  return decisions;
}

/** Real implementation over the already-authenticated `gh` CLI. */
export class GhCliAssetBranchGitHub implements AssetBranchGitHub {
  async listBranches(repo: string, prefix: string): Promise<string[]> {
    const result = await run(['gh', 'api', `repos/${repo}/git/matching-refs/heads/${prefix}`, '--jq', '.[].ref'], { timeoutMs: 60_000 });
    if (result.code !== 0) throw new Error(`listing branches failed for ${repo}: ${result.output.slice(-300)}`);
    return result.output
      .split('\n')
      .map((l) => l.trim().replace(/^refs\/heads\//, ''))
      .filter(Boolean);
  }

  async listPrs(repo: string): Promise<Array<{ number: number; state: PrState; body: string }>> {
    const result = await run(['gh', 'pr', 'list', '-R', repo, '--state', 'all', '--limit', '200', '--json', 'number,state,body'], {
      timeoutMs: 60_000,
    });
    if (result.code !== 0) throw new Error(`listing PRs failed for ${repo}: ${result.output.slice(-300)}`);
    return JSON.parse(result.output) as Array<{ number: number; state: PrState; body: string }>;
  }

  async deleteBranch(repo: string, branch: string): Promise<void> {
    if (!isAssetBranch(branch)) throw new Error(`refusing to delete non-asset branch ${branch}`);
    const result = await run(['gh', 'api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${branch}`], { timeoutMs: 60_000 });
    if (result.code !== 0) throw new Error(`deleting ${branch} failed: ${result.output.slice(-300)}`);
  }
}
