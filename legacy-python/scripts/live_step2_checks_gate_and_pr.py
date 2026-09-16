"""Stage 2 of the live run: independently re-run test/lint/typecheck/build in
the worktree (never trust the implementer's self-report), evaluate the
safety gate, and — only if the gate says proceed — branch/commit/push and
open a draft PR. Any failure files an entry in the execution approval queue
and stops instead."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from work_agent.audit import AuditLog
from work_agent.execution.checks import run_checks
from work_agent.execution.gate import evaluate_gate
from work_agent.execution.git_ops import GitCliOps
from work_agent.execution.models import RepoInfo
from work_agent.execution.pr_ops import GhCliPullRequestCreator
from work_agent.execution.runbook import ExecutionQueue

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def main():
    handoff = json.loads((DATA_DIR / "live_handoff.json").read_text())
    audit = AuditLog(DATA_DIR / "audit.log.jsonl")
    queue = ExecutionQueue(DATA_DIR / "execution_queue.jsonl")

    worktree_path = handoff["worktree_path"]
    branch_name = handoff["branch_name"]
    task_key = handoff["task_key"]
    task_url = f"https://qed42-operations.atlassian.net/browse/{task_key}"

    repo = RepoInfo(
        project_key="QED42OPSIN",
        owner="qed42",
        repo="operational-intelligence",
        local_path=handoff["repo_local_path"],
        default_branch=handoff["default_branch"],
    )

    audit.log("execution_implementation_finished", {"success": True, "summary": "single-line CSS fix in PlannerMatrix.tsx (see subagent report)"})

    print("Running independent checks (test, lint, typecheck, build)...")
    checks = run_checks(worktree_path, timeout=900)
    for c in checks:
        print(f"  {c.name}: {'PASS' if c.passed else 'FAIL'}")
        if not c.passed:
            print(f"    tail of output:\n{c.output[-1500:]}")
    audit.log("execution_checks_run", {"results": [{"name": c.name, "passed": c.passed} for c in checks]})

    git_ops = GitCliOps()
    diff_stat = git_ops.diff_stat(worktree_path, base_ref=f"origin/{repo.default_branch}")
    print(f"\nDiff stat:\n{diff_stat}")

    gate = evaluate_gate(checks, diff_stat)
    audit.log("execution_gate_decision", {"proceed": gate.proceed, "reasons": gate.reasons})
    print(f"\nGate decision: {'PROCEED' if gate.proceed else 'STOP'}")
    for r in gate.reasons:
        print(f"  - {r}")

    if not gate.proceed:
        entry = {
            "id": f"exec-failed-checks:{task_key}",
            "action": "manual_review_failed_gate",
            "target": task_key,
            "target_url": task_url,
            "status": "pending_approval",
            "reason": "; ".join(gate.reasons),
        }
        queue.append(entry)
        audit.log("execution_stopped_failed_checks", entry)
        print("\nStopped. Filed to execution_queue.jsonl for manual review. Worktree left in place for inspection.")
        return 1

    git_ops.create_branch(worktree_path, branch_name)
    commit_message = (
        f"{task_key}: fix overlapping allocation labels in frozen panel during scroll\n\n"
        "Sticky Personnel-column label div for project sub-rows had no background color, "
        "so scrolled allocation bars showed through it. Added bg-surface-muted to match "
        "the pattern used by sibling rows in the same component.\n\n"
        "Co-Authored-By: Work Agent <work-agent@local>"
    )
    committed = git_ops.commit_all(worktree_path, message=commit_message)
    if not committed:
        entry = {
            "id": f"exec-empty-diff:{task_key}",
            "action": "manual_review_empty_diff",
            "target": task_key,
            "target_url": task_url,
            "status": "pending_approval",
            "reason": "implementation reported success but produced no file changes",
        }
        queue.append(entry)
        audit.log("execution_stopped_ambiguous", entry)
        print("\nNothing to commit — stopped.")
        return 1

    print(f"\nCommitted on branch {branch_name}. Pushing...")
    git_ops.push(worktree_path, branch_name)
    audit.log("execution_pushed", {"branch": branch_name})

    checks_line = ", ".join(f"{c.name}={'pass' if c.passed else 'FAIL'}" for c in checks)
    pr_body = (
        f"Autonomous implementation of [{task_key}]({task_url}).\n\n"
        "**Root cause:** the sticky Personnel-column label div for project sub-rows in "
        "`PlannerMatrix.tsx` had no background color (unlike sibling rows), so allocation "
        "bars scrolling underneath the frozen panel showed through it.\n\n"
        "**Fix:** added `bg-surface-muted` to that div, matching the pattern already used "
        "elsewhere in the same component. Single line changed, one file.\n\n"
        f"**Checks (re-run independently by the orchestrator, not just self-reported):** {checks_line}\n\n"
        "_Opened as a draft by the Work Agent — no merge, no deploy, review required before "
        "anything further happens._"
    )
    pr_creator = GhCliPullRequestCreator()
    pr_url = pr_creator.create_draft_pr(
        repo, branch_name,
        title=f"{task_key}: Fix overlapping allocation labels in frozen panel during scroll",
        body=pr_body,
    )
    audit.log("execution_pr_opened", {"url": pr_url})
    print(f"\nDraft PR opened: {pr_url}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
