from __future__ import annotations

from typing import List

from .models import GitHubPR, JiraIssue, SlackMessage, WorkItem


def correlate(
    jira_issues: List[JiraIssue],
    prs: List[GitHubPR],
    messages: List[SlackMessage],
) -> List[WorkItem]:
    """Group Jira issues, GitHub PRs, and Slack messages into WorkItems.

    A PR or Slack message is linked to a Jira issue when a Jira key found in
    its title/branch/text matches an issue in `jira_issues`. Anything that
    doesn't match a known issue becomes its own standalone WorkItem (a PR
    with no ticket, or a Slack message that directly mentions the user).
    """
    items_by_key = {issue.key: WorkItem(id=issue.key, jira=issue) for issue in jira_issues}

    standalone: List[WorkItem] = []

    for pr in prs:
        matched_any = False
        for key in pr.jira_keys():
            if key in items_by_key:
                items_by_key[key].prs.append(pr)
                matched_any = True
        if not matched_any:
            standalone.append(WorkItem(id=f"pr:{pr.repo}#{pr.number}", prs=[pr]))

    for msg in messages:
        matched_any = False
        for key in msg.jira_keys():
            if key in items_by_key:
                items_by_key[key].slack_messages.append(msg)
                matched_any = True
        if not matched_any and msg.mentions_me:
            standalone.append(WorkItem(id=f"slack:{msg.channel}:{msg.ts}", slack_messages=[msg]))

    return list(items_by_key.values()) + standalone
