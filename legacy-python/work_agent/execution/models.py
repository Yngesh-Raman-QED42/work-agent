from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class JiraComment:
    author: str
    body: str


@dataclass
class TaskContext:
    """Everything known about a candidate Jira task before we decide to act on it."""

    key: str
    project: str
    summary: str
    description: str
    issue_type: str  # "Task" | "Bug" | "Story" | "Epic" | ...
    status: str
    priority: str
    url: str
    comments: list[JiraComment] = field(default_factory=list)

    def full_text(self) -> str:
        """All human-authored text on the ticket, for keyword scanning."""
        parts = [self.summary, self.description] + [c.body for c in self.comments]
        return "\n".join(p for p in parts if p)


@dataclass
class RepoInfo:
    project_key: str  # Jira project key this repo is mapped to
    owner: str
    repo: str
    local_path: str
    default_branch: str = "main"

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.repo}"


@dataclass
class CheckResult:
    name: str  # "test" | "lint" | "typecheck" | "build"
    command: str
    passed: bool
    output: str  # tail of stdout+stderr, truncated


@dataclass
class GateDecision:
    proceed: bool
    reasons: list[str] = field(default_factory=list)


@dataclass
class ExecutionResult:
    status: str  # "opened_pr" | "stopped_ambiguous" | "stopped_failed_checks" | "no_eligible_task"
    task: Optional[TaskContext] = None
    branch: Optional[str] = None
    pr_url: Optional[str] = None
    checks: list[CheckResult] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    diff_stat: Optional[str] = None
    worktree_path: Optional[str] = None
