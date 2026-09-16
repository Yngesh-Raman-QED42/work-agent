import shutil
import tempfile
import unittest
from pathlib import Path

from work_agent.models import JiraIssue, WorkItem
from work_agent.state import StateStore, diff_state


def make_item(item_id="ABC-1", category="fyi", urgency="low"):
    return WorkItem(
        id=item_id,
        jira=JiraIssue(
            key=item_id, project="ABC", summary="s", status="To Do",
            status_category="To Do", priority="Low", updated="2026-01-01T00:00:00Z",
            url="http://x",
        ),
        category=category,
        urgency=urgency,
    )


class TestStateStore(unittest.TestCase):
    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)
        self.store = StateStore(self.tmpdir / "state.json")

    def test_load_missing_file_returns_empty(self):
        self.assertEqual(self.store.load(), {})

    def test_save_then_load_round_trip(self):
        item = make_item()
        self.store.save([item])
        loaded = self.store.load()
        self.assertIn("ABC-1", loaded)
        self.assertEqual(loaded["ABC-1"]["category"], "fyi")


class TestDiffState(unittest.TestCase):
    def test_new_item_detected(self):
        diff = diff_state({}, [make_item("ABC-1")])
        self.assertEqual(diff.new, ["ABC-1"])
        self.assertEqual(diff.resolved, [])
        self.assertEqual(diff.changed, [])

    def test_resolved_item_detected(self):
        previous = {"ABC-1": make_item("ABC-1").to_dict()}
        diff = diff_state(previous, [])
        self.assertEqual(diff.resolved, ["ABC-1"])

    def test_changed_category_detected(self):
        previous = {"ABC-1": make_item("ABC-1", category="fyi").to_dict()}
        diff = diff_state(previous, [make_item("ABC-1", category="needs_action")])
        self.assertEqual(diff.changed, ["ABC-1"])
        self.assertEqual(diff.unchanged, [])

    def test_unchanged_item_detected(self):
        previous = {"ABC-1": make_item("ABC-1", category="fyi", urgency="low").to_dict()}
        diff = diff_state(previous, [make_item("ABC-1", category="fyi", urgency="low")])
        self.assertEqual(diff.unchanged, ["ABC-1"])
        self.assertEqual(diff.changed, [])


if __name__ == "__main__":
    unittest.main()
