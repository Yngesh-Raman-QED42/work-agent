from __future__ import annotations

import base64
import os
from typing import List

from ..models import JiraIssue

JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC"


class LiveJiraConnector:
    """Read-only Jira Cloud REST v3 client. Only ever issues GET requests —
    there is no write/edit method on this class, deliberately, for Phase 1.

    Requires env vars: JIRA_BASE_URL (e.g. https://your-site.atlassian.net),
    JIRA_EMAIL, JIRA_API_TOKEN (https://id.atlassian.com/manage-profile/security/api-tokens).
    """

    def __init__(self, base_url: str | None = None, email: str | None = None, api_token: str | None = None):
        self.base_url = (base_url or os.environ.get("JIRA_BASE_URL", "")).rstrip("/")
        self.email = email or os.environ.get("JIRA_EMAIL", "")
        self.api_token = api_token or os.environ.get("JIRA_API_TOKEN", "")
        if not (self.base_url and self.email and self.api_token):
            raise RuntimeError(
                "LiveJiraConnector requires JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN"
            )

    def _auth_header(self) -> str:
        raw = f"{self.email}:{self.api_token}".encode("utf-8")
        return "Basic " + base64.b64encode(raw).decode("ascii")

    def fetch_my_open_issues(self) -> List[JiraIssue]:
        import requests  # imported lazily so mock-only usage never needs this dependency

        resp = requests.get(
            f"{self.base_url}/rest/api/3/search/jql",
            headers={"Authorization": self._auth_header(), "Accept": "application/json"},
            params={
                "jql": JQL,
                "maxResults": 100,
                "fields": "summary,status,priority,updated,project",
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()

        issues: List[JiraIssue] = []
        for node in data.get("issues", []):
            fields = node["fields"]
            issues.append(
                JiraIssue(
                    key=node["key"],
                    project=fields["project"]["key"],
                    summary=fields["summary"],
                    status=fields["status"]["name"],
                    status_category=fields["status"]["statusCategory"]["name"],
                    priority=(fields.get("priority") or {}).get("name", "None"),
                    updated=fields["updated"],
                    url=f"{self.base_url}/browse/{node['key']}",
                )
            )
        return issues
