import unittest

from work_agent.models import GitHubPR, SlackMessage, extract_jira_keys


class TestExtractJiraKeys(unittest.TestCase):
    def test_finds_single_key(self):
        self.assertEqual(extract_jira_keys("please check QED42OPSIN-59 today"), ["QED42OPSIN-59"])

    def test_finds_multiple_unique_keys_in_order(self):
        text = "relates to ABC-1 and also ABC-1 and DEF-22"
        self.assertEqual(extract_jira_keys(text), ["ABC-1", "DEF-22"])

    def test_no_key_present(self):
        self.assertEqual(extract_jira_keys("no ticket mentioned here"), [])

    def test_ignores_lowercase_projectlike_text(self):
        self.assertEqual(extract_jira_keys("see section-42 of the doc"), [])

    def test_multiple_texts_merged(self):
        self.assertEqual(extract_jira_keys("see ABC-1", "and XYZ-2"), ["ABC-1", "XYZ-2"])


class TestSlackMessageJiraKeys(unittest.TestCase):
    def test_extracts_from_text(self):
        msg = SlackMessage(
            channel="C1", channel_name="#c", ts="1", user="U1",
            text="ping about QED42OPSIN-59", permalink="http://x",
        )
        self.assertEqual(msg.jira_keys(), ["QED42OPSIN-59"])


class TestGitHubPRJiraKeys(unittest.TestCase):
    def test_extracts_from_title_and_branch(self):
        pr = GitHubPR(
            repo="r", number=1, title="QED42OPSIN-59: fix thing", url="http://x",
            state="open", is_draft=False, branch="fix/other-77-thing",
            is_author=True, review_requested_of_me=False, review_state="none",
            updated_at="2026-01-01T00:00:00Z",
        )
        # branch text is lowercase ("other-77") so it should NOT match; only the title key should.
        self.assertEqual(pr.jira_keys(), ["QED42OPSIN-59"])


if __name__ == "__main__":
    unittest.main()
