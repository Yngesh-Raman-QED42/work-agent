import unittest

from work_agent.correlate import correlate
from work_agent.models import GitHubPR, JiraIssue, SlackMessage


def make_issue(key="ABC-1", status="In Progress", status_category="In Progress", priority="Medium"):
    return JiraIssue(
        key=key, project=key.split("-")[0], summary=f"summary for {key}",
        status=status, status_category=status_category, priority=priority,
        updated="2026-01-01T00:00:00Z", url=f"http://x/{key}",
    )


def make_pr(title, is_author=True, review_requested=False, review_state="none", branch="feature/x"):
    return GitHubPR(
        repo="org/repo", number=1, title=title, url="http://pr",
        state="open", is_draft=False, branch=branch, is_author=is_author,
        review_requested_of_me=review_requested, review_state=review_state,
        updated_at="2026-01-01T00:00:00Z",
    )


def make_msg(text, mentions_me=False):
    return SlackMessage(
        channel="C1", channel_name="#c", ts="1.0", user="U1",
        text=text, permalink="http://slack", mentions_me=mentions_me,
    )


class TestCorrelate(unittest.TestCase):
    def test_pr_links_to_matching_jira_issue(self):
        issue = make_issue("ABC-1")
        pr = make_pr("ABC-1: fix the bug")
        items = correlate([issue], [pr], [])
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].id, "ABC-1")
        self.assertEqual(items[0].prs, [pr])

    def test_unmatched_pr_becomes_standalone(self):
        pr = make_pr("chore: bump deps", branch="chore/bump")
        items = correlate([], [pr], [])
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].id, "pr:org/repo#1")
        self.assertEqual(items[0].prs, [pr])
        self.assertIsNone(items[0].jira)

    def test_slack_message_with_key_links_to_issue(self):
        issue = make_issue("ABC-1")
        msg = make_msg("any update on ABC-1?")
        items = correlate([issue], [], [msg])
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].slack_messages, [msg])

    def test_slack_message_mentioning_me_without_key_is_standalone(self):
        msg = make_msg("@you can you take a look at this?", mentions_me=True)
        items = correlate([], [], [msg])
        self.assertEqual(len(items), 1)
        self.assertTrue(items[0].id.startswith("slack:"))

    def test_slack_message_without_key_or_mention_is_dropped(self):
        msg = make_msg("lunch at 1pm?", mentions_me=False)
        items = correlate([], [], [msg])
        self.assertEqual(items, [])

    def test_issue_with_no_prs_or_messages_still_included(self):
        issue = make_issue("ABC-2")
        items = correlate([issue], [], [])
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].prs, [])
        self.assertEqual(items[0].slack_messages, [])

    def test_pr_can_match_multiple_issues(self):
        issue1 = make_issue("ABC-1")
        issue2 = make_issue("ABC-2")
        pr = make_pr("ABC-1 and ABC-2: shared fix")
        items = correlate([issue1, issue2], [pr], [])
        ids = {i.id for i in items}
        self.assertEqual(ids, {"ABC-1", "ABC-2"})
        for item in items:
            self.assertEqual(item.prs, [pr])


if __name__ == "__main__":
    unittest.main()
