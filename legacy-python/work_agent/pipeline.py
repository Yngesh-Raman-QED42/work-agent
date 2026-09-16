from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from datetime import date
from typing import List

from .approval_queue import generate_approval_queue
from .audit import AuditLog
from .briefing import generate_briefing
from .classify import classify_all
from .config import Config
from .connectors.base import GitHubConnector, JiraConnector, SlackConnector
from .correlate import correlate
from .models import WorkItem
from .state import StateDiff, StateStore, diff_state


@dataclass
class PipelineResult:
    items: List[WorkItem]
    diff: StateDiff
    briefing: str
    briefing_path: str
    approval_queue: list[dict]
    approval_queue_path: str
    audit_path: str


def run_pipeline(
    config: Config,
    slack: SlackConnector,
    jira: JiraConnector,
    github: GitHubConnector,
    run_date: str | None = None,
) -> PipelineResult:
    run_date = run_date or date.today().isoformat()
    audit = AuditLog(config.data_dir / "audit.log.jsonl")
    audit.log("run_started", {"mode": config.mode, "run_date": run_date})

    messages = slack.fetch_relevant_messages(lookback_hours=config.lookback_hours)
    audit.log("collected_slack", {"count": len(messages)})

    issues = jira.fetch_my_open_issues()
    audit.log("collected_jira", {"count": len(issues)})

    prs = github.fetch_my_pull_requests()
    audit.log("collected_github", {"count": len(prs)})

    items = correlate(issues, prs, messages)
    audit.log("correlated", {"work_item_count": len(items)})

    items = classify_all(items)
    audit.log("classified", {"by_category": dict(Counter(i.category for i in items))})

    store = StateStore(config.data_dir / "state.json")
    previous = store.load()
    diff = diff_state(previous, items)
    store.save(items)
    audit.log("state_updated", diff.to_dict())

    briefing_text = generate_briefing(items, diff, run_date)
    briefing_path = config.data_dir / "briefings" / f"{run_date}.md"
    briefing_path.parent.mkdir(parents=True, exist_ok=True)
    briefing_path.write_text(briefing_text, encoding="utf-8")
    audit.log("briefing_generated", {"path": str(briefing_path)})

    queue = generate_approval_queue(items)
    queue_path = config.data_dir / "approval_queue.json"
    queue_path.write_text(json.dumps(queue, indent=2), encoding="utf-8")
    audit.log("approval_queue_generated", {"count": len(queue)})

    audit.log("run_completed", {})

    return PipelineResult(
        items=items,
        diff=diff,
        briefing=briefing_text,
        briefing_path=str(briefing_path),
        approval_queue=queue,
        approval_queue_path=str(queue_path),
        audit_path=str(audit.path),
    )
