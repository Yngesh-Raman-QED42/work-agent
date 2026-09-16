from __future__ import annotations

from typing import List, Protocol

from ..models import GitHubPR, JiraIssue, SlackMessage


class SlackConnector(Protocol):
    """Read-only. No connector in this package may post, edit, or delete anything."""

    def fetch_relevant_messages(self, *, lookback_hours: int) -> List[SlackMessage]:
        ...


class JiraConnector(Protocol):
    """Read-only. No connector in this package may edit, transition, or comment."""

    def fetch_my_open_issues(self) -> List[JiraIssue]:
        ...


class GitHubConnector(Protocol):
    """Read-only. No connector in this package may push, merge, or comment."""

    def fetch_my_pull_requests(self) -> List[GitHubPR]:
        ...
