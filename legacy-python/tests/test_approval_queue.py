import unittest

from work_agent.approval_queue import generate_approval_queue
from work_agent.models import GitHubPR, JiraIssue, WorkItem


def make_pr(is_author=True, review_requested=False, review_state="none"):
    return GitHubPR(
        repo="org/repo", number=1, title="ABC-1: fix", url="http://pr",
        state="open", is_draft=False, branch="fix/abc-1", is_author=is_author,
        review_requested_of_me=review_requested, review_state=review_state,
        updated_at="2026-01-01T00:00:00Z",
    )


def make_issue(status="On Hold"):
    return JiraIssue(
        key="ABC-1", project="ABC", summary="s", status=status,
        status_category="In Progress", priority="Medium",
        updated="2026-01-01T00:00:00Z", url="http://x",
    )


class TestApprovalQueue(unittest.TestCase):
    def test_needs_review_produces_review_action(self):
        item = WorkItem(id="ABC-1", prs=[make_pr(is_author=False, review_requested=True)], category="needs_review")
        queue = generate_approval_queue([item])
        self.assertEqual(len(queue), 1)
        self.assertEqual(queue[0]["action"], "review_pull_request")
        self.assertEqual(queue[0]["status"], "pending_approval")

    def test_changes_requested_produces_address_review_action(self):
        item = WorkItem(id="ABC-1", prs=[make_pr(is_author=True, review_state="changes_requested")], category="needs_action")
        queue = generate_approval_queue([item])
        self.assertEqual(queue[0]["action"], "address_review_comments")

    def test_in_progress_no_pr_produces_create_pr_suggestion(self):
        item = WorkItem(id="ABC-1", jira=make_issue(status="In Progress"), category="needs_action")
        queue = generate_approval_queue([item])
        self.assertEqual(queue[0]["action"], "create_branch_or_pr")

    def test_blocked_produces_followup_action(self):
        item = WorkItem(id="ABC-1", jira=make_issue(status="On Hold"), category="blocked")
        queue = generate_approval_queue([item])
        self.assertEqual(queue[0]["action"], "comment_asking_for_unblock_status")

    def test_fyi_produces_no_action(self):
        item = WorkItem(id="ABC-1", jira=make_issue(status="To Do"), category="fyi")
        queue = generate_approval_queue([item])
        self.assertEqual(queue, [])

    def test_every_entry_is_pending_never_executed(self):
        items = [
            WorkItem(id="A", prs=[make_pr(is_author=False, review_requested=True)], category="needs_review"),
            WorkItem(id="B", jira=make_issue(status="On Hold"), category="blocked"),
        ]
        queue = generate_approval_queue(items)
        self.assertTrue(all(entry["status"] == "pending_approval" for entry in queue))


if __name__ == "__main__":
    unittest.main()
