from __future__ import annotations

from typing import List

from .models import WorkItem

# Phase 1 only ever *proposes* actions for a human to approve later — nothing
# in this module executes anything against Slack/Jira/GitHub.


def generate_approval_queue(items: List[WorkItem]) -> List[dict]:
    queue: List[dict] = []

    for item in items:
        if item.category == "needs_review":
            for pr in item.prs:
                if pr.review_requested_of_me and pr.state == "open":
                    queue.append(
                        {
                            "id": f"review:{pr.repo}#{pr.number}",
                            "action": "review_pull_request",
                            "target": f"{pr.repo}#{pr.number}",
                            "target_url": pr.url,
                            "status": "pending_approval",
                            "reason": f"Review requested on {pr.repo}#{pr.number}",
                        }
                    )

        if item.category == "needs_action":
            for pr in item.prs:
                if pr.is_author and pr.review_state == "changes_requested":
                    queue.append(
                        {
                            "id": f"address-review:{pr.repo}#{pr.number}",
                            "action": "address_review_comments",
                            "target": f"{pr.repo}#{pr.number}",
                            "target_url": pr.url,
                            "status": "pending_approval",
                            "reason": f"Changes requested on your PR {pr.repo}#{pr.number}",
                        }
                    )
            if item.jira and not item.prs:
                queue.append(
                    {
                        "id": f"start-pr:{item.jira.key}",
                        "action": "create_branch_or_pr",
                        "target": item.jira.key,
                        "target_url": item.jira.url,
                        "status": "pending_approval",
                        "reason": f"{item.jira.key} is in progress with no linked PR yet",
                    }
                )

        if item.category == "blocked" and item.jira:
            queue.append(
                {
                    "id": f"followup:{item.jira.key}",
                    "action": "comment_asking_for_unblock_status",
                    "target": item.jira.key,
                    "target_url": item.jira.url,
                    "status": "pending_approval",
                    "reason": f"{item.jira.key} is On Hold — confirm still blocked or resume",
                }
            )

    return queue
