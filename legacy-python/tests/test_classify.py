import unittest

from work_agent.classify import classify
from work_agent.models import GitHubPR, JiraIssue, SlackMessage, WorkItem


def make_issue(status="In Progress", status_category="In Progress", priority="Medium"):
    return JiraIssue(
        key="ABC-1", project="ABC", summary="do the thing",
        status=status, status_category=status_category, priority=priority,
        updated="2026-01-01T00:00:00Z", url="http://x/ABC-1",
    )


def make_pr(is_author=True, review_requested=False, review_state="none", state="open"):
    return GitHubPR(
        repo="org/repo", number=1, title="ABC-1: fix", url="http://pr",
        state=state, is_draft=False, branch="fix/abc-1", is_author=is_author,
        review_requested_of_me=review_requested, review_state=review_state,
        updated_at="2026-01-01T00:00:00Z",
    )


class TestClassify(unittest.TestCase):
    def test_review_requested_is_needs_review_high(self):
        item = WorkItem(id="ABC-1", prs=[make_pr(is_author=False, review_requested=True)])
        classify(item)
        self.assertEqual(item.category, "needs_review")
        self.assertEqual(item.urgency, "high")

    def test_changes_requested_on_own_pr_is_needs_action_high(self):
        item = WorkItem(id="ABC-1", prs=[make_pr(is_author=True, review_state="changes_requested")])
        classify(item)
        self.assertEqual(item.category, "needs_action")
        self.assertEqual(item.urgency, "high")

    def test_own_open_pr_awaiting_review_is_waiting_on_others(self):
        item = WorkItem(id="ABC-1", prs=[make_pr(is_author=True, review_state="none")])
        classify(item)
        self.assertEqual(item.category, "waiting_on_others")
        self.assertEqual(item.urgency, "medium")

    def test_on_hold_issue_is_blocked(self):
        item = WorkItem(id="ABC-1", jira=make_issue(status="On Hold"))
        classify(item)
        self.assertEqual(item.category, "blocked")

    def test_in_progress_issue_with_no_pr_is_needs_action(self):
        item = WorkItem(id="ABC-1", jira=make_issue(status="In Progress", status_category="In Progress"))
        classify(item)
        self.assertEqual(item.category, "needs_action")

    def test_high_priority_bumps_urgency(self):
        item = WorkItem(id="ABC-1", jira=make_issue(status="To Do", status_category="To Do", priority="High"))
        classify(item)
        self.assertEqual(item.urgency, "high")

    def test_slack_only_mention_is_slack_mention_category(self):
        msg = SlackMessage(channel="C1", channel_name="#c", ts="1", user="U1", text="hi", permalink="x", mentions_me=True)
        item = WorkItem(id="slack:C1:1", slack_messages=[msg])
        classify(item)
        self.assertEqual(item.category, "slack_mention")

    def test_default_is_fyi_low(self):
        item = WorkItem(id="ABC-1", jira=make_issue(status="To Do", status_category="To Do", priority="Low"))
        classify(item)
        self.assertEqual(item.category, "fyi")
        self.assertEqual(item.urgency, "low")

    def test_reasons_populated(self):
        item = WorkItem(id="ABC-1", jira=make_issue(status="On Hold"))
        classify(item)
        self.assertTrue(any("On Hold" in r for r in item.reasons))


if __name__ == "__main__":
    unittest.main()
