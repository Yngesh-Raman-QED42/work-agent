from __future__ import annotations

import os
import tempfile
import uuid

from . import shell


class WorktreeManager:
    """Creates/removes an isolated `git worktree` off a repo's default branch.
    Never touches the caller's primary checkout — that's the entire point.
    """

    def __init__(self, repo_local_path: str, worktrees_root: str | None = None):
        self.repo_local_path = repo_local_path
        self.worktrees_root = worktrees_root or os.path.join(tempfile.gettempdir(), "work-agent-worktrees")

    def create(self, name_hint: str, base_branch: str = "main") -> str:
        os.makedirs(self.worktrees_root, exist_ok=True)
        path = os.path.join(self.worktrees_root, f"{name_hint}-{uuid.uuid4().hex[:8]}")

        shell.run_or_raise(["git", "fetch", "origin", base_branch], cwd=self.repo_local_path, timeout=120)
        shell.run_or_raise(
            ["git", "worktree", "add", "--detach", path, f"origin/{base_branch}"],
            cwd=self.repo_local_path,
            timeout=120,
        )
        return path

    def remove(self, path: str) -> None:
        shell.run(["git", "worktree", "remove", "--force", path], cwd=self.repo_local_path, timeout=60)
