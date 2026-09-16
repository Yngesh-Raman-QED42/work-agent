from __future__ import annotations

from typing import List

from ..models import GitHubPR


class MockGitHubConnector:
    """Fixture data for tests/dry-runs. Never touches a real GitHub account."""

    def __init__(self, prs: List[GitHubPR] | None = None):
        self._prs = prs if prs is not None else default_fixture_prs()

    def fetch_my_pull_requests(self) -> List[GitHubPR]:
        return list(self._prs)


def default_fixture_prs() -> List[GitHubPR]:
    return [
        GitHubPR(
            repo="qed42/operational-intelligence",
            number=101,
            title="QED42OPSIN-59: fix capacity planner search ranking",
            url="https://github.com/qed42/operational-intelligence/pull/101",
            state="open",
            is_draft=False,
            branch="fix/qed42opsin-59-search-ranking",
            is_author=True,
            review_requested_of_me=False,
            review_state="changes_requested",
            updated_at="2026-09-06T09:15:00+05:30",
        ),
        GitHubPR(
            repo="qed42/operational-intelligence",
            number=97,
            title="Add export/download for filtered timesheet reports",
            url="https://github.com/qed42/operational-intelligence/pull/97",
            state="open",
            is_draft=False,
            branch="feature/timesheet-export",
            is_author=True,
            review_requested_of_me=False,
            review_state="none",
            updated_at="2026-09-04T18:00:00+05:30",
        ),
        GitHubPR(
            repo="qed42/operational-intelligence",
            number=103,
            title="Bump next.js to patch CVE",
            url="https://github.com/qed42/operational-intelligence/pull/103",
            state="open",
            is_draft=False,
            branch="chore/bump-nextjs",
            is_author=False,
            review_requested_of_me=True,
            review_state="none",
            updated_at="2026-09-07T11:30:00+05:30",
        ),
    ]
