from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, List, Optional

from ..audit import AuditLog
from .checks import run_checks
from .claude_runner import ClaudeCodeRunner
from .gate import GateConfig, evaluate_gate
from .git_ops import GitOps
from .models import ExecutionResult, TaskContext
from .policy import AutonomyPolicy
from .pr_ops import PullRequestCreator
from .prompt import build_implementation_prompt
from .repo_map import resolve_repo
from .selector import select_task
from .worktree import WorktreeManager


class ExecutionQueue:
    """Append-only pending-approval list for Phase 2 stops. Kept separate
    from Phase 1's approval_queue.json (which is fully rebuilt every
    observation run) — this one accumulates across execution attempts."""

    def __init__(self, path: Path):
        self.path = path

    def append(self, entry: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, sort_keys=True) + "\n")

    def read_all(self) -> List[dict]:
        if not self.path.exists():
            return []
        return [json.loads(line) for line in self.path.read_text().splitlines() if line.strip()]


def run_execution(
    data_dir: Path,
    candidates: List[TaskContext],
    policy: AutonomyPolicy,
    claude_runner: ClaudeCodeRunner,
    git_ops: GitOps,
    pr_creator: PullRequestCreator,
    has_existing_pr: Callable[[str], bool] = lambda key: False,
    worktree_manager_factory: Optional[Callable[[str], WorktreeManager]] = None,
    gate_config: Optional[GateConfig] = None,
    check_commands=None,
    keep_worktree_on_stop: bool = True,
) -> ExecutionResult:
    audit = AuditLog(data_dir / "audit.log.jsonl")
    queue = ExecutionQueue(data_dir / "execution_queue.jsonl")

    audit.log("execution_run_started", {"candidate_count": len(candidates)})

    selection = select_task(candidates, policy, has_existing_pr)
    audit.log(
        "execution_candidates_evaluated",
        {"evaluations": [{"key": e.task.key, "eligible": e.eligible, "reasons": e.reasons} for e in selection.evaluations]},
    )

    if selection.picked is None:
        audit.log("execution_no_eligible_task", {})
        return ExecutionResult(status="no_eligible_task", reasons=["no candidate satisfied the autonomy policy"])

    task = selection.picked
    audit.log("execution_task_selected", {"key": task.key, "summary": task.summary})

    repo = resolve_repo(task.project)
    if repo is None:
        entry = {
            "id": f"exec-ambiguous:{task.key}",
            "action": "manual_review_no_repo_mapping",
            "target": task.key,
            "status": "pending_approval",
            "reason": f"no repository is mapped for project {task.project!r}",
        }
        queue.append(entry)
        audit.log("execution_stopped_ambiguous", entry)
        return ExecutionResult(status="stopped_ambiguous", task=task, reasons=[entry["reason"]])

    wt_manager = worktree_manager_factory(repo.local_path) if worktree_manager_factory else WorktreeManager(repo.local_path)
    worktree_path = wt_manager.create(name_hint=task.key.lower(), base_branch=repo.default_branch)
    audit.log("execution_worktree_created", {"path": worktree_path, "base_branch": repo.default_branch})

    prompt = build_implementation_prompt(task, worktree_path)
    outcome = claude_runner.run(worktree_path, prompt)
    audit.log("execution_implementation_finished", {"success": outcome.success, "summary": outcome.summary})

    if not outcome.success:
        entry = {
            "id": f"exec-ambiguous:{task.key}",
            "action": "manual_review_implementation_stopped",
            "target": task.key,
            "target_url": task.url,
            "status": "pending_approval",
            "reason": outcome.summary,
        }
        queue.append(entry)
        audit.log("execution_stopped_ambiguous", entry)
        if not keep_worktree_on_stop:
            wt_manager.remove(worktree_path)
        return ExecutionResult(status="stopped_ambiguous", task=task, reasons=[outcome.summary], worktree_path=worktree_path)

    checks = run_checks(worktree_path, commands=check_commands)
    audit.log("execution_checks_run", {"results": [{"name": c.name, "passed": c.passed} for c in checks]})

    diff_stat = git_ops.diff_stat(worktree_path, base_ref=f"origin/{repo.default_branch}")
    gate = evaluate_gate(checks, diff_stat, config=gate_config)
    audit.log("execution_gate_decision", {"proceed": gate.proceed, "reasons": gate.reasons})

    if not gate.proceed:
        entry = {
            "id": f"exec-failed-checks:{task.key}",
            "action": "manual_review_failed_gate",
            "target": task.key,
            "target_url": task.url,
            "status": "pending_approval",
            "reason": "; ".join(gate.reasons),
        }
        queue.append(entry)
        audit.log("execution_stopped_failed_checks", entry)
        return ExecutionResult(
            status="stopped_failed_checks", task=task, checks=checks, reasons=gate.reasons, diff_stat=diff_stat, worktree_path=worktree_path
        )

    branch_name = f"work-agent/{task.key.lower()}"
    git_ops.create_branch(worktree_path, branch_name)
    commit_message = f"{task.key}: {task.summary}\n\n{outcome.summary}\n\nCo-Authored-By: Work Agent <work-agent@local>"
    committed = git_ops.commit_all(worktree_path, message=commit_message)
    if not committed:
        entry = {
            "id": f"exec-empty-diff:{task.key}",
            "action": "manual_review_empty_diff",
            "target": task.key,
            "target_url": task.url,
            "status": "pending_approval",
            "reason": "implementation reported success but produced no file changes",
        }
        queue.append(entry)
        audit.log("execution_stopped_ambiguous", entry)
        return ExecutionResult(status="stopped_ambiguous", task=task, checks=checks, reasons=[entry["reason"]], worktree_path=worktree_path)

    git_ops.push(worktree_path, branch_name)
    audit.log("execution_pushed", {"branch": branch_name})

    checks_line = ", ".join(f"{c.name}={'pass' if c.passed else 'FAIL'}" for c in checks)
    pr_body = (
        f"Autonomous implementation of [{task.key}]({task.url}).\n\n"
        f"**Summary of changes:** {outcome.summary}\n\n"
        f"**Checks:** {checks_line}\n\n"
        "_Opened as a draft by the Work Agent — no merge, no deploy, review required before anything further happens._"
    )
    pr_url = pr_creator.create_draft_pr(repo, branch_name, title=f"{task.key}: {task.summary}", body=pr_body)
    audit.log("execution_pr_opened", {"url": pr_url})

    return ExecutionResult(
        status="opened_pr",
        task=task,
        branch=branch_name,
        pr_url=pr_url,
        checks=checks,
        diff_stat=diff_stat,
        worktree_path=worktree_path,
        reasons=gate.reasons,
    )
