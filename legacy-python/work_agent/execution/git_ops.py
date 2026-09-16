from __future__ import annotations

from typing import Protocol

from . import shell


class GitOps(Protocol):
    """No method here ever touches `main`/the default branch, force-pushes,
    or merges anything. Branch/commit/push only, on the caller-supplied
    isolated branch name, inside the caller-supplied worktree."""

    def create_branch(self, worktree_path: str, branch_name: str) -> None: ...

    def commit_all(self, worktree_path: str, message: str) -> bool:
        """Returns False if there was nothing to commit."""
        ...

    def push(self, worktree_path: str, branch_name: str) -> None: ...

    def diff_stat(self, worktree_path: str, base_ref: str = "HEAD") -> str: ...


class GitCliOps:
    """Real git operations via subprocess. Safe by construction: every call
    is scoped to `worktree_path`, which the caller is expected to have
    created via WorktreeManager (never the primary checkout)."""

    def create_branch(self, worktree_path: str, branch_name: str) -> None:
        shell.run_or_raise(["git", "checkout", "-b", branch_name], cwd=worktree_path)

    def commit_all(self, worktree_path: str, message: str) -> bool:
        shell.run_or_raise(["git", "add", "-A"], cwd=worktree_path)
        status = shell.run_or_raise(["git", "status", "--porcelain"], cwd=worktree_path)
        if not status.output.strip():
            return False
        shell.run_or_raise(["git", "commit", "-m", message], cwd=worktree_path)
        return True

    def push(self, worktree_path: str, branch_name: str) -> None:
        shell.run_or_raise(["git", "push", "-u", "origin", branch_name], cwd=worktree_path, timeout=180)

    def diff_stat(self, worktree_path: str, base_ref: str = "HEAD") -> str:
        result = shell.run_or_raise(["git", "diff", "--stat", base_ref], cwd=worktree_path)
        return result.output


class MockGitOps:
    """Records calls, never touches disk or a remote. For orchestration tests."""

    def __init__(self, fake_diff_stat: str = " src/example.ts | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)"):
        self.calls: list[tuple] = []
        self._fake_diff_stat = fake_diff_stat
        self.has_changes = True

    def create_branch(self, worktree_path: str, branch_name: str) -> None:
        self.calls.append(("create_branch", worktree_path, branch_name))

    def commit_all(self, worktree_path: str, message: str) -> bool:
        self.calls.append(("commit_all", worktree_path, message))
        return self.has_changes

    def push(self, worktree_path: str, branch_name: str) -> None:
        self.calls.append(("push", worktree_path, branch_name))

    def diff_stat(self, worktree_path: str, base_ref: str = "HEAD") -> str:
        self.calls.append(("diff_stat", worktree_path, base_ref))
        return self._fake_diff_stat
