from __future__ import annotations

from typing import List, Optional, Tuple

from . import shell
from .models import CheckResult

DEFAULT_COMMANDS: List[Tuple[str, List[str]]] = [
    ("test", ["npm", "test"]),
    ("lint", ["npm", "run", "lint"]),
    ("typecheck", ["npx", "tsc", "--noEmit"]),
    ("build", ["npm", "run", "build"]),
]

_OUTPUT_TAIL_CHARS = 4000


def run_checks(
    worktree_path: str,
    commands: Optional[List[Tuple[str, List[str]]]] = None,
    timeout: int = 900,
) -> List[CheckResult]:
    commands = commands if commands is not None else DEFAULT_COMMANDS
    results: List[CheckResult] = []
    for name, cmd in commands:
        result = shell.run(cmd, cwd=worktree_path, timeout=timeout)
        tail = result.output[-_OUTPUT_TAIL_CHARS:] if len(result.output) > _OUTPUT_TAIL_CHARS else result.output
        results.append(CheckResult(name=name, command=" ".join(cmd), passed=result.ok, output=tail))
    return results
