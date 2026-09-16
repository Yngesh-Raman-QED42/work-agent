import shutil
import tempfile
import unittest
from pathlib import Path

from work_agent.audit import AuditLog


class TestAuditLog(unittest.TestCase):
    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)
        self.audit = AuditLog(self.tmpdir / "audit.log.jsonl")

    def test_log_appends_entry_with_expected_fields(self):
        entry = self.audit.log("run_started", {"mode": "mock"})
        self.assertEqual(entry["event"], "run_started")
        self.assertEqual(entry["details"], {"mode": "mock"})
        self.assertIn("ts", entry)

    def test_multiple_entries_are_appended_not_overwritten(self):
        self.audit.log("run_started", {})
        self.audit.log("run_completed", {})
        entries = self.audit.read_all()
        self.assertEqual([e["event"] for e in entries], ["run_started", "run_completed"])

    def test_read_all_on_missing_file_returns_empty(self):
        missing = AuditLog(self.tmpdir / "does_not_exist.jsonl")
        self.assertEqual(missing.read_all(), [])

    def test_entries_are_valid_jsonl(self):
        self.audit.log("event_a", {"x": 1})
        self.audit.log("event_b", {"y": [1, 2, 3]})
        lines = self.audit.path.read_text().splitlines()
        self.assertEqual(len(lines), 2)


if __name__ == "__main__":
    unittest.main()
