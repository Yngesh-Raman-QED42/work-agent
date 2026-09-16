import json
import shutil
import tempfile
import unittest
from pathlib import Path

from work_agent.config import Config
from work_agent.connectors.mock_github import MockGitHubConnector
from work_agent.connectors.mock_jira import MockJiraConnector
from work_agent.connectors.mock_slack import MockSlackConnector
from work_agent.pipeline import run_pipeline


class TestPipelineEndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)
        self.config = Config(mode="mock", data_dir=self.tmpdir)

    def run_once(self, run_date="2026-09-09"):
        return run_pipeline(
            self.config,
            MockSlackConnector(),
            MockJiraConnector(),
            MockGitHubConnector(),
            run_date=run_date,
        )

    def test_produces_briefing_queue_and_audit_files(self):
        result = self.run_once()
        self.assertTrue(Path(result.briefing_path).exists())
        self.assertTrue(Path(result.approval_queue_path).exists())
        self.assertTrue(Path(result.audit_path).exists())

    def test_briefing_is_nonempty_and_mentions_a_known_ticket(self):
        result = self.run_once()
        self.assertIn("QED42OPSIN-59", result.briefing)

    def test_approval_queue_has_entries_from_fixtures(self):
        result = self.run_once()
        self.assertGreater(len(result.approval_queue), 0)
        actions = {entry["action"] for entry in result.approval_queue}
        self.assertIn("address_review_comments", actions)  # PR #101 has changes_requested
        self.assertIn("review_pull_request", actions)      # PR #103 review-requested of me

    def test_audit_log_records_full_run_sequence(self):
        self.run_once()
        from work_agent.audit import AuditLog

        audit = AuditLog(self.tmpdir / "audit.log.jsonl")
        events = [e["event"] for e in audit.read_all()]
        self.assertEqual(
            events,
            [
                "run_started",
                "collected_slack",
                "collected_jira",
                "collected_github",
                "correlated",
                "classified",
                "state_updated",
                "briefing_generated",
                "approval_queue_generated",
                "run_completed",
            ],
        )

    def test_first_run_has_no_prior_state_everything_is_new(self):
        result = self.run_once()
        self.assertEqual(set(result.diff.new), {i.id for i in result.items})
        self.assertEqual(result.diff.resolved, [])
        self.assertEqual(result.diff.changed, [])

    def test_second_run_with_unchanged_fixtures_has_no_new_or_resolved(self):
        self.run_once(run_date="2026-09-09")
        result2 = self.run_once(run_date="2026-09-10")
        self.assertEqual(result2.diff.new, [])
        self.assertEqual(result2.diff.resolved, [])
        self.assertEqual(result2.diff.changed, [])
        self.assertEqual(set(result2.diff.unchanged), {i.id for i in result2.items})

    def test_state_file_persists_between_runs(self):
        self.run_once()
        state_path = self.tmpdir / "state.json"
        self.assertTrue(state_path.exists())
        data = json.loads(state_path.read_text())
        self.assertIn("QED42OPSIN-59", data)

    def test_no_connector_used_has_a_write_method(self):
        # Guards the Phase 1 constraint: observation/reporting only, no mutation.
        for connector in (MockSlackConnector(), MockJiraConnector(), MockGitHubConnector()):
            for name in dir(connector):
                self.assertFalse(
                    name.startswith(("post_", "send_", "update_", "edit_", "delete_", "create_", "transition_", "merge_", "push_")),
                    f"{connector.__class__.__name__}.{name} looks like a write method",
                )


if __name__ == "__main__":
    unittest.main()
