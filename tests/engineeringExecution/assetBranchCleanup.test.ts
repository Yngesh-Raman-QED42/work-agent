import { describe, expect, it } from 'vitest';
import { cleanupAssetBranches, type AssetBranchGitHub, type PrState } from '../../src/agents/engineeringExecution/assetBranchCleanup.js';

const raw = (branch: string) => `![shot](https://github.com/org/repo/raw/${branch}/home.png)`;

function fakeGitHub(branches: string[], prs: Array<{ number: number; state: PrState; body: string }>, failDelete = false) {
  const deleted: string[] = [];
  const gh: AssetBranchGitHub = {
    listBranches: async (_repo, prefix) => branches.filter((b) => b.startsWith(prefix)),
    listPrs: async () => prs,
    deleteBranch: async (_repo, branch) => {
      if (failDelete) throw new Error('403 forbidden');
      deleted.push(branch);
    },
  };
  return { gh, deleted };
}

describe('cleanupAssetBranches', () => {
  it('deletes an asset branch once every PR linking to it is merged or closed', async () => {
    const { gh, deleted } = fakeGitHub(
      ['pr-assets/lsd-34', 'work-agent/screenshots/proj-1'],
      [
        { number: 20, state: 'MERGED', body: raw('pr-assets/lsd-34') },
        { number: 21, state: 'CLOSED', body: raw('work-agent/screenshots/proj-1') },
      ],
    );
    const decisions = await cleanupAssetBranches(['org/repo'], gh);
    expect(deleted.sort()).toEqual(['pr-assets/lsd-34', 'work-agent/screenshots/proj-1']);
    expect(decisions.every((d) => d.action === 'deleted')).toBe(true);
  });

  it('keeps a branch while any PR linking to it is still open', async () => {
    const { gh, deleted } = fakeGitHub(
      ['pr-assets/lsd-34'],
      [
        { number: 19, state: 'MERGED', body: raw('pr-assets/lsd-34') },
        { number: 20, state: 'OPEN', body: raw('pr-assets/lsd-34') },
      ],
    );
    const [d] = await cleanupAssetBranches(['org/repo'], gh);
    expect(deleted).toEqual([]);
    expect(d).toMatchObject({ action: 'kept', reason: 'PR #20 still open' });
  });

  it('keeps a branch no PR links to — it cannot tell what it is for', async () => {
    const { gh, deleted } = fakeGitHub(['pr-assets/mystery'], [{ number: 5, state: 'MERGED', body: 'no images here' }]);
    const [d] = await cleanupAssetBranches(['org/repo'], gh);
    expect(deleted).toEqual([]);
    expect(d).toMatchObject({ action: 'kept', reason: 'no PR links to it' });
  });

  it('does not confuse a branch with a longer one that shares its name as a prefix', async () => {
    const { gh, deleted } = fakeGitHub(
      ['pr-assets/lsd-3', 'pr-assets/lsd-34'],
      [{ number: 20, state: 'MERGED', body: raw('pr-assets/lsd-34') }],
    );
    await cleanupAssetBranches(['org/repo'], gh);
    expect(deleted).toEqual(['pr-assets/lsd-34']);
  });

  it('never considers branches outside the asset prefixes', async () => {
    const { gh, deleted } = fakeGitHub(['main', 'lsd-34-feature'], [{ number: 20, state: 'MERGED', body: raw('lsd-34-feature') }]);
    expect(await cleanupAssetBranches(['org/repo'], gh)).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it('records a failed delete instead of throwing', async () => {
    const { gh } = fakeGitHub(['pr-assets/x'], [{ number: 1, state: 'MERGED', body: raw('pr-assets/x') }], true);
    const [d] = await cleanupAssetBranches(['org/repo'], gh);
    expect(d).toMatchObject({ action: 'failed' });
    expect(d!.reason).toContain('403');
  });
});
