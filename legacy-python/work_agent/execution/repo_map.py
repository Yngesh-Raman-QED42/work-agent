from __future__ import annotations

from .models import RepoInfo

# Known mappings in this environment. Extend as more Jira projects get a
# home repo; an unmapped project should be treated as "ambiguous — can't
# find the relevant repository" rather than guessed at.
_REPO_MAP: dict[str, RepoInfo] = {
    "QED42OPSIN": RepoInfo(
        project_key="QED42OPSIN",
        owner="qed42",
        repo="operational-intelligence",
        local_path="/home/admin1/Desktop/operational-intelligence",
        default_branch="main",
    ),
}


def resolve_repo(project_key: str) -> RepoInfo | None:
    return _REPO_MAP.get(project_key)
