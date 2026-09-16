"""Tests real git operations (WorktreeManager, GitCliOps) against a throwaway
scratch repo created fresh in a temp dir — never touches any real project."""

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from work_agent.execution.git_ops import GitCliOps
from work_agent.execution.worktree import WorktreeManager


def _run(cmd, cwd):
    subprocess.run(cmd, cwd=cwd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


class TestGitPlumbing(unittest.TestCase):
    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)

        self.bare_remote = self.tmpdir / "remote.git"
        self.local_repo = self.tmpdir / "local"
        self.worktrees_root = self.tmpdir / "worktrees"

        _run(["git", "init", "--bare", str(self.bare_remote)], cwd=self.tmpdir)
        _run(["git", "clone", str(self.bare_remote), str(self.local_repo)], cwd=self.tmpdir)
        _run(["git", "config", "user.email", "test@example.com"], cwd=self.local_repo)
        _run(["git", "config", "user.name", "Test"], cwd=self.local_repo)
        (self.local_repo / "README.md").write_text("hello\n")
        _run(["git", "add", "-A"], cwd=self.local_repo)
        _run(["git", "commit", "-m", "initial commit"], cwd=self.local_repo)
        _run(["git", "branch", "-M", "main"], cwd=self.local_repo)
        _run(["git", "push", "-u", "origin", "main"], cwd=self.local_repo)

        self.manager = WorktreeManager(str(self.local_repo), worktrees_root=str(self.worktrees_root))

    def test_create_worktree_does_not_disturb_primary_checkout(self):
        primary_branch_before = subprocess.run(
            ["git", "branch", "--show-current"], cwd=self.local_repo, capture_output=True, text=True
        ).stdout.strip()

        path = self.manager.create("test-task", base_branch="main")
        self.assertTrue(Path(path).exists())
        self.assertTrue((Path(path) / "README.md").exists())

        primary_branch_after = subprocess.run(
            ["git", "branch", "--show-current"], cwd=self.local_repo, capture_output=True, text=True
        ).stdout.strip()
        self.assertEqual(primary_branch_before, primary_branch_after)

    def test_remove_worktree_cleans_up(self):
        path = self.manager.create("test-task", base_branch="main")
        self.manager.remove(path)
        self.assertFalse(Path(path).exists())

    def test_full_branch_commit_push_round_trip(self):
        path = self.manager.create("feature-task", base_branch="main")
        ops = GitCliOps()

        ops.create_branch(path, "work-agent/feature-task")
        (Path(path) / "new_file.txt").write_text("new content\n")
        committed = ops.commit_all(path, "add new_file.txt")
        self.assertTrue(committed)

        diff = ops.diff_stat(path, base_ref="origin/main")
        self.assertIn("new_file.txt", diff)

        ops.push(path, "work-agent/feature-task")

        # Verify it actually landed on the "remote".
        branches = subprocess.run(
            ["git", "branch", "-a"], cwd=self.bare_remote, capture_output=True, text=True
        ).stdout
        self.assertIn("work-agent/feature-task", branches)

    def test_commit_all_returns_false_when_nothing_changed(self):
        path = self.manager.create("no-op-task", base_branch="main")
        ops = GitCliOps()
        ops.create_branch(path, "work-agent/no-op-task")
        committed = ops.commit_all(path, "nothing changed")
        self.assertFalse(committed)


if __name__ == "__main__":
    unittest.main()
