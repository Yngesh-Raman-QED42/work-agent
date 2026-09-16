import unittest

from work_agent.execution.models import JiraComment, TaskContext
from work_agent.execution.policy import AutonomyPolicy

# These mirror the four real QED42OPSIN tickets this policy was designed
# against (redacted the same way the real Jira data already was). Keeping
# them as regression fixtures means a future policy tweak can't silently
# re-admit the "do not start" or permissions tickets.

CSS_OVERLAP_BUG = TaskContext(
    key="QED42OPSIN-60",
    project="QED42OPSIN",
    summary="Capacity Planner | Fix Overlapping Allocation Labels in Frozen Panel During Scroll",
    description=(
        "As a Capacity Planner user, I want allocation labels and project names to render "
        "correctly while scrolling so that I can clearly identify personnel and project "
        "allocations without UI overlap. Allocation bars and their labels should remain "
        "confined to the timeline/grid area and should not overlap the Personnel section."
    ),
    issue_type="Task",
    status="To Do",
    priority="Medium",
    url="http://x/QED42OPSIN-60",
)

SEARCH_BUG = TaskContext(
    key="QED42OPSIN-59",
    project="QED42OPSIN",
    summary="Capacity Planner | Fix Capacity Planner Search Results",
    description=(
        "Investigate and fix the Capacity Planner search functionality to ensure it accurately "
        "filters and displays data based on the entered search term. Should return matching "
        "personnel and projects and exclude unrelated ones from the results."
    ),
    issue_type="Task",
    status="To Do",
    priority="Medium",
    url="http://x/QED42OPSIN-59",
)

PERMISSION_BUG = TaskContext(
    key="QED42OPSIN-51",
    project="QED42OPSIN",
    summary='Capacity Planner: "Create Allocations" permission on Project Manager role is not honoured',
    description=(
        "Despite Create Allocations being enabled on the Project Manager role, the PM user was "
        "still unable to create allocations. The action only succeeded after granting full Admin "
        "rights. This suggests the allocation-creation permission check is not reading the role "
        "permission correctly."
    ),
    issue_type="Bug",
    status="To Do",
    priority="Low",
    url="http://x/QED42OPSIN-51",
)

ON_HOLD_TASK = TaskContext(
    key="QED42OPSIN-54",
    project="QED42OPSIN",
    summary="Support per-user permission overrides on top of role-level permissions",
    description=(
        "Support granting additional permissions to an individual user on top of their base role, "
        "so per-user exceptions do not require editing the shared role or escalating to Admin."
    ),
    issue_type="Task",
    status="To Do",
    priority="Medium",
    url="http://x/QED42OPSIN-54",
    comments=[JiraComment(author="Anand Toshniwal", body="keep this one on hold.. do not start working on this one")],
)


class TestAutonomyPolicy(unittest.TestCase):
    def setUp(self):
        self.policy = AutonomyPolicy()

    def test_css_overlap_bug_is_eligible(self):
        eligible, reasons = self.policy.is_eligible(CSS_OVERLAP_BUG)
        self.assertTrue(eligible, reasons)

    def test_search_bug_is_eligible(self):
        eligible, reasons = self.policy.is_eligible(SEARCH_BUG)
        self.assertTrue(eligible, reasons)

    def test_permission_bug_excluded_as_sensitive(self):
        eligible, reasons = self.policy.is_eligible(PERMISSION_BUG)
        self.assertFalse(eligible)
        self.assertTrue(any("sensitive" in r for r in reasons), reasons)

    def test_on_hold_task_excluded_by_comment(self):
        eligible, reasons = self.policy.is_eligible(ON_HOLD_TASK)
        self.assertFalse(eligible)
        self.assertTrue(any("hold" in r.lower() for r in reasons), reasons)

    def test_wrong_project_excluded(self):
        task = TaskContext(
            key="KOTAKTNM-1", project="KOTAKTNM", summary="s", description="d" * 100,
            issue_type="Task", status="To Do", priority="Medium", url="http://x",
        )
        eligible, reasons = self.policy.is_eligible(task)
        self.assertFalse(eligible)
        self.assertIn("allowlist", reasons[0])

    def test_high_priority_excluded(self):
        task = TaskContext(
            key="QED42OPSIN-1", project="QED42OPSIN", summary="s", description="d" * 100,
            issue_type="Task", status="To Do", priority="High", url="http://x",
        )
        eligible, reasons = self.policy.is_eligible(task)
        self.assertFalse(eligible)

    def test_epic_issue_type_excluded(self):
        task = TaskContext(
            key="QED42OPSIN-1", project="QED42OPSIN", summary="s", description="d" * 100,
            issue_type="Epic", status="To Do", priority="Medium", url="http://x",
        )
        eligible, reasons = self.policy.is_eligible(task)
        self.assertFalse(eligible)

    def test_in_progress_status_excluded(self):
        task = TaskContext(
            key="QED42OPSIN-1", project="QED42OPSIN", summary="s", description="d" * 100,
            issue_type="Task", status="In Progress", priority="Medium", url="http://x",
        )
        eligible, reasons = self.policy.is_eligible(task)
        self.assertFalse(eligible)

    def test_thin_description_excluded(self):
        task = TaskContext(
            key="QED42OPSIN-1", project="QED42OPSIN", summary="s", description="too short",
            issue_type="Task", status="To Do", priority="Medium", url="http://x",
        )
        eligible, reasons = self.policy.is_eligible(task)
        self.assertFalse(eligible)

    def test_blocking_phrase_in_description_itself_is_caught(self):
        task = TaskContext(
            key="QED42OPSIN-1", project="QED42OPSIN", summary="s",
            description="This needs doing eventually but please do not start until Q3. " * 3,
            issue_type="Task", status="To Do", priority="Medium", url="http://x",
        )
        eligible, reasons = self.policy.is_eligible(task)
        self.assertFalse(eligible)


if __name__ == "__main__":
    unittest.main()
