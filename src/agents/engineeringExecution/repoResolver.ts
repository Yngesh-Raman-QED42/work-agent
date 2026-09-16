import type { WorkAgentConfig } from '../../config/index.js';
import type { RepoInfo } from './models.js';

/**
 * Resolves a Jira project key to a repo purely from user-maintained config
 * (`work-agent.config.json`) — nothing here is hardcoded to any specific
 * project. Returns null (never a guess) when:
 *   - the project has no entry in `github.repoMap`,
 *   - the resolved repo isn't in `github.approvedRepos` (mapped but not
 *     opted in for autonomy), or
 *   - there's no known local clone path for it.
 * The caller must treat null as "ambiguous, can't act" and stop.
 */
export function resolveRepo(config: WorkAgentConfig, projectKey: string): RepoInfo | null {
  const fullName = config.github.repoMap[projectKey];
  if (!fullName) return null;
  if (!config.github.approvedRepos.includes(fullName)) return null;

  const localPath = config.github.repoLocalPaths[fullName];
  if (!localPath) return null;

  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) return null;

  return {
    projectKey,
    owner,
    repo,
    localPath,
    defaultBranch: config.github.repoDefaultBranches[fullName] ?? 'main',
  };
}
