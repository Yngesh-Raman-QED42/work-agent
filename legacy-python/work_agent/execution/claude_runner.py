from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class RunOutcome:
    success: bool
    summary: str
    files_touched: list[str] = field(default_factory=list)


class ClaudeCodeRunner(Protocol):
    """Implements the "start Claude Code against the worktree, give it the
    task, require it to inspect before modifying" step.

    IMPORTANT: there is deliberately no "Live" subprocess implementation of
    this in the package. Spawning an unattended `claude -p ... --permission-
    mode bypassPermissions` process was tried and blocked by this
    environment's own safety classifier (an agent with all permission
    checks bypassed is exactly the pattern it exists to catch). The correct
    live implementation is for the ORCHESTRATING Claude Code session itself
    to spawn a properly-permissioned subagent (its `Agent` tool) scoped to
    the worktree directory — that keeps every file edit and shell command
    the implementer runs subject to the same permission system already
    governing the orchestrating session, instead of an opaque bypass.
    This is why `run_pipeline`/`Runbook` takes an injected `ClaudeCodeRunner`
    rather than constructing one itself: the live case is provided by the
    calling session, not by this module.
    """

    def run(self, worktree_path: str, prompt: str) -> RunOutcome: ...


class MockClaudeCodeRunner:
    """For tests. Optionally simulates writing a file so downstream
    diff/gate logic has something real to look at."""

    def __init__(self, outcome: RunOutcome | None = None, write_file: tuple[str, str] | None = None):
        self._outcome = outcome or RunOutcome(success=True, summary="mock implementation complete")
        self._write_file = write_file
        self.calls: list[tuple[str, str]] = []

    def run(self, worktree_path: str, prompt: str) -> RunOutcome:
        self.calls.append((worktree_path, prompt))
        if self._write_file:
            import os

            rel_path, content = self._write_file
            full_path = os.path.join(worktree_path, rel_path)
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, "w") as f:
                f.write(content)
        return self._outcome
