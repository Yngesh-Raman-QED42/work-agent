from __future__ import annotations

import os
import time
from typing import List

from ..models import SlackMessage


class LiveSlackConnector:
    """Read-only Slack Web API client. Only ever calls read endpoints
    (search.messages) — there is no chat.postMessage or similar on this
    class, deliberately, for Phase 1.

    Requires env vars SLACK_USER_TOKEN (xoxp-... with search:read scope) and
    SLACK_USER_ID (your own member id, e.g. U0123456, used to detect @-mentions).
    """

    def __init__(self, token: str | None = None, user_id: str | None = None):
        self.token = token or os.environ.get("SLACK_USER_TOKEN", "")
        self.user_id = user_id or os.environ.get("SLACK_USER_ID", "")
        if not (self.token and self.user_id):
            raise RuntimeError("LiveSlackConnector requires SLACK_USER_TOKEN and SLACK_USER_ID")

    def fetch_relevant_messages(self, *, lookback_hours: int = 24) -> List[SlackMessage]:
        import requests  # imported lazily so mock-only usage never needs this dependency

        after_ts = time.time() - lookback_hours * 3600
        query = f"after:{time.strftime('%Y-%m-%d', time.gmtime(after_ts))}"

        resp = requests.get(
            "https://slack.com/api/search.messages",
            headers={"Authorization": f"Bearer {self.token}"},
            params={"query": query, "count": 100, "sort": "timestamp"},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get("ok"):
            raise RuntimeError(f"Slack search.messages failed: {data.get('error')}")

        messages: List[SlackMessage] = []
        for match in data.get("messages", {}).get("matches", []):
            text = match.get("text", "")
            messages.append(
                SlackMessage(
                    channel=match.get("channel", {}).get("id", ""),
                    channel_name=match.get("channel", {}).get("name", ""),
                    ts=match.get("ts", ""),
                    user=match.get("user", ""),
                    text=text,
                    permalink=match.get("permalink", ""),
                    mentions_me=f"<@{self.user_id}>" in text,
                )
            )
        return messages
