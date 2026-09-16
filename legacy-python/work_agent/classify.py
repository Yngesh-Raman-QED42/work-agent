from __future__ import annotations

from .models import WorkItem

URGENCY_RANK = {"high": 0, "medium": 1, "low": 2}
_HIGH_PRIORITY_NAMES = {"highest", "high"}


def classify(item: WorkItem) -> WorkItem:
    """Deterministic, rule-based classification — no ML/LLM call in Phase 1.

    category one of: needs_review, needs_action, blocked, waiting_on_others,
    slack_mention, fyi.
    urgency one of: high, medium, low.
    """
    category = "fyi"
    urgency = "low"
    reasons: list[str] = []

    for pr in item.prs:
        if pr.review_requested_of_me and pr.state == "open":
            category = "needs_review"
            urgency = "high"
            reasons.append(f"Review requested on {pr.repo}#{pr.number}")
        elif pr.is_author and pr.review_state == "changes_requested":
            category = "needs_action"
            urgency = "high"
            reasons.append(f"Changes requested on your PR {pr.repo}#{pr.number}")
        elif pr.is_author and pr.state == "open" and category == "fyi":
            category = "waiting_on_others"
            urgency = "medium"
            reasons.append(f"Your PR {pr.repo}#{pr.number} is awaiting review")

    if item.jira:
        issue = item.jira
        if issue.status.lower() == "on hold":
            if category == "fyi":
                category = "blocked"
                urgency = "medium"
            reasons.append(f"{issue.key} is On Hold")
        elif issue.status_category == "In Progress" and not item.prs:
            if category == "fyi":
                category = "needs_action"
                urgency = "medium"
            reasons.append(f"{issue.key} is in progress with no linked PR yet")

        if issue.priority.lower() in _HIGH_PRIORITY_NAMES and URGENCY_RANK[urgency] > URGENCY_RANK["high"]:
            urgency = "high"
            reasons.append(f"{issue.key} priority is {issue.priority}")

    if item.slack_messages and category == "fyi":
        category = "slack_mention"
        reasons.append(f"{len(item.slack_messages)} Slack message(s) reference this")

    item.category = category
    item.urgency = urgency
    item.reasons = reasons
    return item


def classify_all(items: list[WorkItem]) -> list[WorkItem]:
    return [classify(i) for i in items]
