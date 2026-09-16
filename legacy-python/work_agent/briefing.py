from __future__ import annotations

from collections import defaultdict
from typing import List

from .models import WorkItem
from .state import StateDiff

_SECTION_ORDER = ["needs_review", "needs_action", "blocked", "waiting_on_others", "slack_mention", "fyi"]
_SECTION_TITLES = {
    "needs_review": "Needs your review",
    "needs_action": "Needs your action",
    "blocked": "Blocked / on hold",
    "waiting_on_others": "Waiting on others",
    "slack_mention": "Slack mentions (no linked ticket)",
    "fyi": "FYI",
}
_URGENCY_RANK = {"high": 0, "medium": 1, "low": 2}


def generate_briefing(items: List[WorkItem], diff: StateDiff, run_date: str) -> str:
    lines = [f"# Morning Briefing — {run_date}", ""]
    lines.append(
        f"Tracking **{len(items)}** work items "
        f"({len(diff.new)} new, {len(diff.changed)} changed, {len(diff.resolved)} resolved since last run)."
    )
    lines.append("")

    by_category: dict[str, list[WorkItem]] = defaultdict(list)
    for item in items:
        by_category[item.category].append(item)

    for category in _SECTION_ORDER:
        cat_items = by_category.get(category, [])
        if not cat_items:
            continue
        cat_items = sorted(cat_items, key=lambda i: _URGENCY_RANK.get(i.urgency, 9))
        lines.append(f"## {_SECTION_TITLES[category]} ({len(cat_items)})")
        for item in cat_items:
            flags = []
            if item.id in diff.new:
                flags.append("NEW")
            if item.id in diff.changed:
                flags.append("CHANGED")
            flag_str = f" [{', '.join(flags)}]" if flags else ""
            lines.append(f"- **{item.label()}** ({item.urgency}){flag_str} — {item.summary()}")
            for reason in item.reasons:
                lines.append(f"  - {reason}")
        lines.append("")

    if diff.resolved:
        lines.append(f"## Resolved since last run ({len(diff.resolved)})")
        for item_id in diff.resolved:
            lines.append(f"- {item_id}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"
