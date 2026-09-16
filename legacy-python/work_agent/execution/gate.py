from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List

from .models import CheckResult, GateDecision

_DEFAULT_FORBIDDEN_PATH_PATTERNS = [
    r"\.github/workflows/",
    r"(^|/)\.env(\.[a-zA-Z0-9_]+)?$",
    r"(^|/)drizzle/",
    r"src/core/db/migrate",
    r"package-lock\.json$",
    r"pnpm-lock\.yaml$",
    r"yarn\.lock$",
    r"(^|/)\.git/",
]


@dataclass
class GateConfig:
    max_changed_files: int = 15
    forbidden_path_patterns: List[str] = field(default_factory=lambda: list(_DEFAULT_FORBIDDEN_PATH_PATTERNS))


def parse_changed_files(diff_stat: str) -> List[str]:
    files = []
    for line in diff_stat.splitlines():
        if "|" not in line:
            continue
        name = line.split("|", 1)[0].strip()
        if name:
            files.append(name)
    return files


def evaluate_gate(checks: List[CheckResult], diff_stat: str, config: GateConfig | None = None) -> GateDecision:
    """The one place that decides whether it's safe to commit/push/open a PR.
    Any failure here means: stop, and the caller must file an approval-queue
    entry instead of proceeding."""
    config = config or GateConfig()
    reasons: List[str] = []

    failed = [c.name for c in checks if not c.passed]
    if failed:
        reasons.append(f"failing checks: {', '.join(failed)}")

    changed_files = parse_changed_files(diff_stat)
    if not changed_files:
        reasons.append("diff is empty — nothing was changed")
    elif len(changed_files) > config.max_changed_files:
        reasons.append(
            f"diff touches {len(changed_files)} files, exceeding the autonomy threshold of {config.max_changed_files}"
        )

    for path in changed_files:
        for pattern in config.forbidden_path_patterns:
            if re.search(pattern, path):
                reasons.append(f"diff touches a forbidden path: {path} (matches /{pattern}/)")

    if reasons:
        return GateDecision(proceed=False, reasons=reasons)
    return GateDecision(proceed=True, reasons=["all checks passed", "diff is non-empty, scoped, and touches no forbidden paths"])
