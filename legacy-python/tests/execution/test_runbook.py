import shutil
import tempfile
import unittest
from pathlib import Path

from work_agent.execution.claude_runner import MockClaudeCodeRunner, RunOutcome
from work_agent.execution.gate import GateConfig
from work_agent.execution.git_ops import MockGitOps
from work_agent.execution.models import TaskContext
from work_agent.execution.policy import AutonomyPolicy
from work_agent.execution.pr_ops import MockPullRequestCreator
from work_agent.execution.runbook import ExecutionQueue, run_execution
from work_agent.execution.worktree import WorktreeManager


NOOP_CHECKS = [("noop", ["true"])]


def make_task(key="QED42OPSIN-60", **overrides):
    defaults = dict(
        key=key, project="QED42OPSIN", summary="Fix overlapping labels", description="d" * 200,
        issue_type="Task", status="To Do", priority="Medium", url=f"http://x/{key}",
    )
    defaults.update(overrides)
    return TaskContext(**defaults)


class FakeWorktreeManager:
    """Avoids real git entirely — just hands back a scratch directory."""

    def __init__(self, repo_local_path):
        self.repo_local_path = repo_local_path
        self.created = []
        self.removed = []

    def create(self, name_hint, base_branch="main"):
        path = tempfile.mkdtemp(prefix=f"{name_hint}-")
        self.created.append(path)
        return path

    def remove(self, path):
        self.removed.append(path)
        shutil.rmtree(path, ignore_errors=True)


class TestRunExecution(unittest.TestCase):
    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)
        self.policy = AutonomyPolicy()

    def _factory(self):
        return lambda repo_path: FakeWorktreeManager(repo_path)

    def test_happy_path_opens_draft_pr(self):
        result = run_execution(
            data_dir=self.tmpdir,
            candidates=[make_task()],
            policy=self.policy,
            claude_runner=MockClaudeCodeRunner(),
            git_ops=MockGitOps(),
            pr_creator=MockPullRequestCreator(),
            worktree_manager_factory=self._factory(),
            check_commands=NOOP_CHECKS,
        )
        self.assertEqual(result.status, "opened_pr")
        self.assertTrue(result.pr_url.startswith("https://github.com/"))
        self.assertEqual(result.branch, "work-agent/qed42opsin-60")

    def test_no_eligible_candidates(self):
        result = run_execution(
            data_dir=self.tmpdir,
            candidates=[make_task(priority="High")],
            policy=self.policy,
            claude_runner=MockClaudeCodeRunner(),
            git_ops=MockGitOps(),
            pr_creator=MockPullRequestCreator(),
            worktree_manager_factory=self._factory(),
        )
        self.assertEqual(result.status, "no_eligible_task")

    def test_unmapped_project_stops_ambiguous(self):
        result = run_execution(
            data_dir=self.tmpdir,
            candidates=[make_task(key="OTHERPROJ-1", project="OTHERPROJ")],
            policy=AutonomyPolicy(allowed_projects={"OTHERPROJ"}),
            claude_runner=MockClaudeCodeRunner(),
            git_ops=MockGitOps(),
            pr_creator=MockPullRequestCreator(),
            worktree_manager_factory=self._factory(),
        )
        self.assertEqual(result.status, "stopped_ambiguous")
        queue = ExecutionQueue(self.tmpdir / "execution_queue.jsonl")
        entries = queue.read_all()
        self.assertEqual(len(entries), 1)
        self.assertIn("no repository is mapped", entries[0]["reason"])

    def test_implementation_failure_stops_ambiguous_and_queues(self):
        failing_runner = MockClaudeCodeRunner(outcome=RunOutcome(success=False, summary="ticket is ambiguous, stopping"))
        result = run_execution(
            data_dir=self.tmpdir,
            candidates=[make_task()],
            policy=self.policy,
            claude_runner=failing_runner,
            git_ops=MockGitOps(),
            pr_creator=MockPullRequestCreator(),
            worktree_manager_factory=self._factory(),
        )
        self.assertEqual(result.status, "stopped_ambiguous")
        queue = ExecutionQueue(self.tmpdir / "execution_queue.jsonl")
        self.assertEqual(len(queue.read_all()), 1)

    def test_failing_checks_stop_before_any_git_push(self):
        git_ops = MockGitOps()
        result = run_execution(
            data_dir=self.tmpdir,
            candidates=[make_task()],
            policy=self.policy,
            claude_runner=MockClaudeCodeRunner(),
            git_ops=git_ops,
            pr_creator=MockPullRequestCreator(),
            worktree_manager_factory=self._factory(),
            check_commands=[("test", ["false"])],
        )
        self.assertEqual(result.status, "stopped_failed_checks")
        self.assertFalse(any(call[0] == "push" for call in git_ops.calls))

    def test_no_actual_changes_stops_ambiguous(self):
        git_ops = MockGitOps()
        git_ops.has_changes = False
        result = run_execution(
            data_dir=self.tmpdir,
            candidates=[make_task()],
            policy=self.policy,
            claude_runner=MockClaudeCodeRunner(),
            git_ops=git_ops,
            pr_creator=MockPullRequestCreator(),
            worktree_manager_factory=self._factory(),
            check_commands=NOOP_CHECKS,
        )
        self.assertEqual(result.status, "stopped_ambiguous")
        self.assertFalse(any(call[0] == "push" for call in git_ops.calls))

    def test_too_many_changed_files_blocks_pr(self):
        big_diff = "\n".join(f" src/file{i}.ts | 1 +" for i in range(20))
        git_ops = MockGitOps(fake_diff_stat=big_diff)
        result = run_execution(
            data_dir=self.tmpdir,
            candidates=[make_task()],
            policy=self.policy,
            claude_runner=MockClaudeCodeRunner(),
            git_ops=git_ops,
            pr_creator=MockPullRequestCreator(),
            worktree_manager_factory=self._factory(),
            check_commands=NOOP_CHECKS,
            gate_config=GateConfig(max_changed_files=15),
        )
        self.assertEqual(result.status, "stopped_failed_checks")

    def test_pr_creator_never_called_on_any_stop_path(self):
        pr_creator = MockPullRequestCreator()
        run_execution(
            data_dir=self.tmpdir,
            candidates=[make_task(priority="High")],
            policy=self.policy,
            claude_runner=MockClaudeCodeRunner(),
            git_ops=MockGitOps(),
            pr_creator=pr_creator,
            worktree_manager_factory=self._factory(),
        )
        self.assertEqual(pr_creator.calls, [])

    def test_audit_log_covers_the_full_happy_path(self):
        run_execution(
            data_dir=self.tmpdir,
            candidates=[make_task()],
            policy=self.policy,
            claude_runner=MockClaudeCodeRunner(),
            git_ops=MockGitOps(),
            pr_creator=MockPullRequestCreator(),
            worktree_manager_factory=self._factory(),
            check_commands=NOOP_CHECKS,
        )
        from work_agent.audit import AuditLog

        events = [e["event"] for e in AuditLog(self.tmpdir / "audit.log.jsonl").read_all()]
        self.assertEqual(
            events,
            [
                "execution_run_started",
                "execution_candidates_evaluated",
                "execution_task_selected",
                "execution_worktree_created",
                "execution_implementation_finished",
                "execution_checks_run",
                "execution_gate_decision",
                "execution_pushed",
                "execution_pr_opened",
            ],
        )


if __name__ == "__main__":
    unittest.main()
