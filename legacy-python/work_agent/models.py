from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from typing import Optional

# Matches Jira-style issue keys, e.g. KOTAKTNM-235, QED42OPSIN-56.
JIRA_KEY_RE = re.compile(r"\b([A-Z][A-Z0-9]{1,9}-\d+)\b")


def extract_jira_keys(*texts: str) -> list[str]:
    keys: list[str] = []
    for text in texts:
        if not text:
            continue
        for match in JIRA_KEY_RE.findall(text):
            if match not in keys:
                keys.append(match)
    return keys


@dataclass
class SlackMessage:
    channel: str
    channel_name: str
    ts: str
    user: str
    text: str
    permalink: str
    thread_ts: Optional[str] = None
    mentions_me: bool = False

    def jira_keys(self) -> list[str]:
        return extract_jira_keys(self.text)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "SlackMessage":
        return cls(**d)


@dataclass
class JiraIssue:
    key: str
    project: str
    summary: str
    status: str
    status_category: str  # "To Do" | "In Progress" | "Done"
    priority: str
    updated: str  # ISO timestamp
    url: str

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "JiraIssue":
        return cls(**d)


@dataclass
class GitHubPR:
    repo: str
    number: int
    title: str
    url: str
    state: str  # "open" | "closed" | "merged"
    is_draft: bool
    branch: str
    is_author: bool
    review_requested_of_me: bool
    review_state: str  # "none" | "changes_requested" | "approved" | "commented"
    updated_at: str

    def jira_keys(self) -> list[str]:
        return extract_jira_keys(self.title, self.branch)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "GitHubPR":
        return cls(**d)


@dataclass
class WorkItem:
    """A correlated unit of work: a Jira issue plus any linked PRs/Slack messages,
    or a standalone PR/Slack thread with no matching Jira ticket."""

    id: str
    jira: Optional[JiraIssue] = None
    prs: list[GitHubPR] = field(default_factory=list)
    slack_messages: list[SlackMessage] = field(default_factory=list)
    category: str = "fyi"
    urgency: str = "low"
    reasons: list[str] = field(default_factory=list)

    def label(self) -> str:
        if self.jira:
            return self.jira.key
        return self.id

    def summary(self) -> str:
        if self.jira:
            return self.jira.summary
        if self.prs:
            return self.prs[0].title
        if self.slack_messages:
            text = self.slack_messages[0].text.strip().replace("\n", " ")
            return text[:100]
        return "(no summary)"

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "jira": self.jira.to_dict() if self.jira else None,
            "prs": [p.to_dict() for p in self.prs],
            "slack_messages": [m.to_dict() for m in self.slack_messages],
            "category": self.category,
            "urgency": self.urgency,
            "reasons": list(self.reasons),
        }

    @classmethod
    def from_dict(cls, d: dict) -> "WorkItem":
        return cls(
            id=d["id"],
            jira=JiraIssue.from_dict(d["jira"]) if d.get("jira") else None,
            prs=[GitHubPR.from_dict(p) for p in d.get("prs", [])],
            slack_messages=[SlackMessage.from_dict(m) for m in d.get("slack_messages", [])],
            category=d.get("category", "fyi"),
            urgency=d.get("urgency", "low"),
            reasons=list(d.get("reasons", [])),
        )
