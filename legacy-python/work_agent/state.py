from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict

from .models import WorkItem


class StateStore:
    """Local JSON snapshot of the last run's WorkItems, keyed by WorkItem.id."""

    def __init__(self, path: Path):
        self.path = path

    def load(self) -> Dict[str, dict]:
        if not self.path.exists():
            return {}
        return json.loads(self.path.read_text())

    def save(self, items: list[WorkItem]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {item.id: item.to_dict() for item in items}
        self.path.write_text(json.dumps(data, indent=2, sort_keys=True))


@dataclass
class StateDiff:
    new: list[str] = field(default_factory=list)
    resolved: list[str] = field(default_factory=list)
    changed: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "new": self.new,
            "resolved": self.resolved,
            "changed": self.changed,
            "unchanged": self.unchanged,
        }


def diff_state(previous: Dict[str, dict], current_items: list[WorkItem]) -> StateDiff:
    prev_ids = set(previous.keys())
    curr_by_id = {i.id: i for i in current_items}
    curr_ids = set(curr_by_id.keys())

    new_ids = curr_ids - prev_ids
    resolved_ids = prev_ids - curr_ids
    changed_ids: list[str] = []
    unchanged_ids: list[str] = []

    for item_id in curr_ids & prev_ids:
        prev_item = previous[item_id]
        curr_item = curr_by_id[item_id]
        if prev_item.get("category") != curr_item.category or prev_item.get("urgency") != curr_item.urgency:
            changed_ids.append(item_id)
        else:
            unchanged_ids.append(item_id)

    return StateDiff(
        new=sorted(new_ids),
        resolved=sorted(resolved_ids),
        changed=sorted(changed_ids),
        unchanged=sorted(unchanged_ids),
    )
