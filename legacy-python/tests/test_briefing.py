import unittest

from work_agent.briefing import generate_briefing
from work_agent.models import JiraIssue, WorkItem
from work_agent.state import StateDiff


def make_item(item_id, category, urgency):
    return WorkItem(
        id=item_id,
        jira=JiraIssue(
            key=item_id, project="ABC", summary=f"summary {item_id}", status="To Do",
            status_category="To Do", priority="Medium", updated="2026-01-01T00:00:00Z",
            url="http://x",
        ),
        category=category,
        urgency=urgency,
        reasons=[f"reason for {item_id}"],
    )


class TestGenerateBriefing(unittest.TestCase):
    def test_includes_run_date_and_counts(self):
        items = [make_item("ABC-1", "needs_review", "high")]
        diff = StateDiff(new=["ABC-1"])
        text = generate_briefing(items, diff, "2026-09-09")
        self.assertIn("2026-09-09", text)
        self.assertIn("Tracking **1** work items", text)

    def test_groups_by_category_with_titles(self):
        items = [
            make_item("ABC-1", "needs_review", "high"),
            make_item("ABC-2", "fyi", "low"),
        ]
        diff = StateDiff()
        text = generate_briefing(items, diff, "2026-09-09")
        self.assertIn("## Needs your review", text)
        self.assertIn("## FYI", text)

    def test_new_flag_shown(self):
        items = [make_item("ABC-1", "fyi", "low")]
        diff = StateDiff(new=["ABC-1"])
        text = generate_briefing(items, diff, "2026-09-09")
        self.assertIn("[NEW]", text)

    def test_resolved_section_present(self):
        items = []
        diff = StateDiff(resolved=["ABC-9"])
        text = generate_briefing(items, diff, "2026-09-09")
        self.assertIn("## Resolved since last run", text)
        self.assertIn("ABC-9", text)

    def test_empty_items_no_category_sections(self):
        text = generate_briefing([], StateDiff(), "2026-09-09")
        self.assertNotIn("## FYI", text)

    def test_high_urgency_sorted_before_low(self):
        items = [
            make_item("ABC-2", "fyi", "low"),
            make_item("ABC-1", "fyi", "high"),
        ]
        text = generate_briefing(items, StateDiff(), "2026-09-09")
        self.assertLess(text.index("ABC-1"), text.index("ABC-2"))


if __name__ == "__main__":
    unittest.main()
