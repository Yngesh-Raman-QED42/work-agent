from __future__ import annotations

from typing import Protocol

from . import shell
from .models import RepoInfo


class PullRequestCreator(Protocol):
    """No implementation of this may ever merge a PR — creation only, and
    always as a draft."""

    def create_draft_pr(self, repo: RepoInfo, branch: str, title: str, body: str) -> str:
        """Returns the PR URL."""
        ...


class GhCliPullRequestCreator:
    """Uses the `gh` CLI (already authenticated with real org access in this
    environment — the GitHub MCP plugin's PAT is scoped to personal repos
    only and can't see org repos, so this is the mechanism that actually
    works here). Always passes --draft; never calls `gh pr merge`."""

    def create_draft_pr(self, repo: RepoInfo, branch: str, title: str, body: str) -> str:
        cmd = [
            "gh", "pr", "create",
            "--repo", repo.full_name,
            "--head", branch,
            "--base", repo.default_branch,
            "--draft",
            "--title", title,
            "--body", body,
        ]
        result = shell.run_or_raise(cmd, cwd=repo.local_path, timeout=120)
        lines = [line.strip() for line in result.output.strip().splitlines() if line.strip()]
        return lines[-1] if lines else ""


class MockPullRequestCreator:
    def __init__(self):
        self.calls: list[dict] = []

    def create_draft_pr(self, repo: RepoInfo, branch: str, title: str, body: str) -> str:
        self.calls.append({"repo": repo.full_name, "branch": branch, "title": title, "body": body})
        return f"https://github.com/{repo.full_name}/pull/999"
