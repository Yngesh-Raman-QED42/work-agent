from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable, List, Optional

from .models import TaskContext
from .policy import AutonomyPolicy

_BULLET_LINE_RE = re.compile(r"(?m)^\s*(?:[-*•]|\d+[.)])\s+\S")


def _requirement_count(task: TaskContext) -> int:
    """Number of enumerated requirement/acceptance-criteria lines. A more
    robust scope proxy than raw description length: resistant to one ticket
    just being written more verbosely than another, and it directly reads
    "how many distinct things does this ticket ask for.\""""
    return len(_BULLET_LINE_RE.findall(task.description))


@dataclass
class CandidateEvaluation:
    task: TaskContext
    eligible: bool
    reasons: list[str]
    excluded_duplicate: bool = False


@dataclass
class SelectionResult:
    picked: Optional[TaskContext]
    evaluations: List[CandidateEvaluation] = field(default_factory=list)


def evaluate_candidates(
    candidates: List[TaskContext],
    policy: AutonomyPolicy,
    has_existing_pr: Callable[[str], bool] = lambda key: False,
) -> List[CandidateEvaluation]:
    evaluations = []
    for task in candidates:
        eligible, reasons = policy.is_eligible(task)
        excluded_duplicate = False
        if eligible and has_existing_pr(task.key):
            eligible = False
            excluded_duplicate = True
            reasons = [f"an open or existing PR already references {task.key}"]
        evaluations.append(CandidateEvaluation(task=task, eligible=eligible, reasons=reasons, excluded_duplicate=excluded_duplicate))
    return evaluations


def select_task(
    candidates: List[TaskContext],
    policy: AutonomyPolicy,
    has_existing_pr: Callable[[str], bool] = lambda key: False,
) -> SelectionResult:
    """Pick the smallest eligible task. Sorts by (a) number of enumerated
    requirement lines, then (b) description length, as a proxy for scope —
    good enough to prefer a single-requirement CSS-overlap fix over an
    open-ended "investigate and fix search relevance, 5 acceptance criteria"
    ticket, not a substitute for real complexity estimation. Ties broken by
    key for determinism."""
    evaluations = evaluate_candidates(candidates, policy, has_existing_pr)
    eligible = [e.task for e in evaluations if e.eligible]
    if not eligible:
        return SelectionResult(picked=None, evaluations=evaluations)

    eligible.sort(key=lambda t: (_requirement_count(t), len(t.description.strip()), t.key))
    return SelectionResult(picked=eligible[0], evaluations=evaluations)
