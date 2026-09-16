from __future__ import annotations

from typing import List

from ..models import JiraIssue


class MockJiraConnector:
    """Fixture data for tests/dry-runs. Never touches a real Jira site."""

    def __init__(self, issues: List[JiraIssue] | None = None):
        self._issues = issues if issues is not None else default_fixture_issues()

    def fetch_my_open_issues(self) -> List[JiraIssue]:
        return list(self._issues)


def default_fixture_issues() -> List[JiraIssue]:
    return [
        JiraIssue(
            key="QED42OPSIN-59",
            project="QED42OPSIN",
            summary="Capacity Planner | Fix Capacity Planner Search Results",
            status="In Progress",
            status_category="In Progress",
            priority="Medium",
            updated="2026-09-05T10:00:00+05:30",
            url="https://example.atlassian.net/browse/QED42OPSIN-59",
        ),
        JiraIssue(
            key="QED42OPSIN-56",
            project="QED42OPSIN",
            summary="Timesheet: Add Report Export/Download Functionality for Filtered Data",
            status="Ready for QA",
            status_category="In Progress",
            priority="High",
            updated="2026-09-04T16:20:00+05:30",
            url="https://example.atlassian.net/browse/QED42OPSIN-56",
        ),
        JiraIssue(
            key="QCBP-368",
            project="QCBP",
            summary="Slack AI assistant with AI Agents and MCP",
            status="On Hold",
            status_category="In Progress",
            priority="Medium",
            updated="2026-08-20T12:00:00+05:30",
            url="https://example.atlassian.net/browse/QCBP-368",
        ),
        JiraIssue(
            key="QGP-463",
            project="QGP",
            summary="DevForge AI App Generation Platform - MVP Development",
            status="Backlog",
            status_category="To Do",
            priority="Medium",
            updated="2026-08-01T09:00:00+05:30",
            url="https://example.atlassian.net/browse/QGP-463",
        ),
    ]
