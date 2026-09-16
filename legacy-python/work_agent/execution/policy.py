from __future__ import annotations

import re
from dataclasses import dataclass, field

from .models import TaskContext

# Explicit human instructions to hold off. Checked against the FULL text
# (summary + description + every comment), because the real-world case that
# motivated this list was a comment — not the description — saying
# "keep this one on hold, do not start working on this one."
_BLOCKING_PHRASES = [
    r"do not start",
    r"don't start",
    r"keep .{0,20}on hold",
    r"put .{0,20}on hold",
    r"hold off",
    r"do not work on",
    r"don't work on",
    r"paused? for now",
]

# Anything touching auth/permissions/security/money is excluded from autonomy
# regardless of how small it looks — those categories have blast radius that
# isn't visible from the diff alone.
_SENSITIVE_KEYWORDS = [
    "permission", "role-based", "rbac", "admin right", "auth", "security",
    "password", "credential", "secret", "token", "payment", "billing",
    "invoice", "salary", "compensation", "pii", "gdpr", "encrypt",
]

_ALLOWED_ISSUE_TYPES = {"task", "bug"}
_ALLOWED_PRIORITIES = {"low", "medium"}
_MIN_DESCRIPTION_LENGTH = 80


@dataclass
class AutonomyPolicy:
    allowed_projects: set[str] = field(default_factory=lambda: {"QED42OPSIN"})
    allowed_issue_types: set[str] = field(default_factory=lambda: set(_ALLOWED_ISSUE_TYPES))
    allowed_priorities: set[str] = field(default_factory=lambda: set(_ALLOWED_PRIORITIES))
    allowed_statuses: set[str] = field(default_factory=lambda: {"to do"})
    min_description_length: int = _MIN_DESCRIPTION_LENGTH
    blocking_phrases: list[str] = field(default_factory=lambda: list(_BLOCKING_PHRASES))
    sensitive_keywords: list[str] = field(default_factory=lambda: list(_SENSITIVE_KEYWORDS))

    def is_eligible(self, task: TaskContext) -> tuple[bool, list[str]]:
        """Returns (eligible, reasons). `reasons` is always populated — on a
        pass it explains why, on a fail it explains what disqualified it."""
        reasons: list[str] = []

        if task.project not in self.allowed_projects:
            return False, [f"project {task.project!r} is not in the autonomy allowlist"]

        if task.issue_type.lower() not in self.allowed_issue_types:
            return False, [f"issue type {task.issue_type!r} is not eligible for autonomous execution"]

        if task.priority.lower() not in self.allowed_priorities:
            return False, [f"priority {task.priority!r} is above the autonomy threshold"]

        if task.status.lower() not in self.allowed_statuses:
            return False, [f"status {task.status!r} is not eligible (expected one of {sorted(self.allowed_statuses)})"]

        full_text = task.full_text()
        full_text_lower = full_text.lower()

        for phrase in self.blocking_phrases:
            if re.search(phrase, full_text_lower):
                return False, [f"found an explicit hold instruction matching /{phrase}/"]

        hit_keywords = [kw for kw in self.sensitive_keywords if kw in full_text_lower]
        if hit_keywords:
            return False, [f"touches sensitive area(s): {', '.join(sorted(set(hit_keywords)))}"]

        if len(task.description.strip()) < self.min_description_length:
            return False, ["description is too short/absent to safely scope autonomous work"]

        reasons.append(f"project {task.project!r} allowed")
        reasons.append(f"issue type {task.issue_type!r} allowed")
        reasons.append(f"priority {task.priority!r} allowed")
        reasons.append(f"status {task.status!r} allowed")
        reasons.append("no blocking instructions found")
        reasons.append("no sensitive keywords found")
        reasons.append(f"description length {len(task.description.strip())} chars, sufficient")
        return True, reasons
