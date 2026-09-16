from __future__ import annotations

import os
from typing import List

from ..models import GitHubPR


class LiveGitHubConnector:
    """Read-only GitHub REST client. Only ever issues GET requests — there is
    no push/merge/comment method on this class, deliberately, for Phase 1.

    Requires env var GITHUB_PERSONAL_ACCESS_TOKEN (or GITHUB_TOKEN).
    """

    def __init__(self, token: str | None = None):
        self.token = token or os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN") or os.environ.get("GITHUB_TOKEN", "")
        if not self.token:
            raise RuntimeError("LiveGitHubConnector requires GITHUB_PERSONAL_ACCESS_TOKEN or GITHUB_TOKEN")
        self._username: str | None = None

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def _me(self, requests) -> str:
        if self._username is None:
            resp = requests.get("https://api.github.com/user", headers=self._headers(), timeout=30)
            resp.raise_for_status()
            self._username = resp.json()["login"]
        return self._username

    def fetch_my_pull_requests(self) -> List[GitHubPR]:
        import requests  # imported lazily so mock-only usage never needs this dependency

        me = self._me(requests)
        prs: dict[str, GitHubPR] = {}

        queries = [
            (f"is:pr is:open author:{me}", True, False),
            (f"is:pr is:open review-requested:{me}", False, True),
        ]
        for query, is_author, review_requested in queries:
            resp = requests.get(
                "https://api.github.com/search/issues",
                headers=self._headers(),
                params={"q": query, "per_page": 50},
                timeout=30,
            )
            resp.raise_for_status()
            for item in resp.json().get("items", []):
                repo_url = item["repository_url"]  # .../repos/{owner}/{repo}
                repo = "/".join(repo_url.split("/")[-2:])
                dedupe_key = f"{repo}#{item['number']}"
                pr = prs.get(dedupe_key) or GitHubPR(
                    repo=repo,
                    number=item["number"],
                    title=item["title"],
                    url=item["html_url"],
                    state="open" if item["state"] == "open" else "closed",
                    is_draft=item.get("draft", False),
                    branch="",  # not available from the search/issues API; left blank
                    is_author=False,
                    review_requested_of_me=False,
                    review_state="none",
                    updated_at=item["updated_at"],
                )
                if is_author:
                    pr.is_author = True
                if review_requested:
                    pr.review_requested_of_me = True
                prs[dedupe_key] = pr

        return list(prs.values())
