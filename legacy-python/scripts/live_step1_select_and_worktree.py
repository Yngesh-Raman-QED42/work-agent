"""Stage 1 of the live run: gather real Jira context, run the real policy and
selector against it, resolve the repo, and create a real isolated worktree.

This mirrors work_agent.execution.runbook.run_execution() up to (but not
including) the "start Claude Code against the worktree" step — that step has
to be a live Agent-tool call made by the orchestrating Claude Code session
itself, which can't happen from inside a plain subprocess. See
claude_runner.py for why. This script hands off by printing the worktree
path and the implementation prompt for the orchestrator to use next.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from work_agent.audit import AuditLog
from work_agent.execution.models import JiraComment, TaskContext
from work_agent.execution.policy import AutonomyPolicy
from work_agent.execution.prompt import build_implementation_prompt
from work_agent.execution.repo_map import resolve_repo
from work_agent.execution.selector import evaluate_candidates, select_task
from work_agent.execution.worktree import WorktreeManager

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# Real candidates: the four real QED42OPSIN tickets assigned to the user,
# fetched live from Jira earlier this session (descriptions/comments as
# returned by getJiraIssue, PII already redacted by Jira per the requester's
# own instruction on QED42OPSIN-51/54).
CANDIDATES = [
    # Descriptions below are the verbatim markdown returned by
    # getJiraIssue earlier this session (not paraphrased) — an earlier
    # version of this script paraphrased them, which accidentally inverted
    # their relative lengths and caused the selector to pick the wrong
    # (larger-scope) ticket. See selector.py's requirement-count tiebreak,
    # added after this was caught.
    TaskContext(
        key="QED42OPSIN-60",
        project="QED42OPSIN",
        summary="Capacity Planner | Fix Overlapping Allocation Labels in Frozen Panel During Scroll",
        description=(
            "#### **User Story**\n\n"
            "As a Capacity Planner user, I want allocation labels and project names to render "
            "correctly while scrolling horizontally/vertically so that I can clearly identify "
            "personnel and project allocations without UI overlap.\n\n"
            "---\n\n### **Background**\n\n"
            "The Capacity Planner has a UI rendering issue where allocation labels overlap with "
            "the frozen **Personnel** panel during horizontal/vertical scrolling. As shown in the "
            "attached screenshot, the allocation bar text extends into the left fixed section, "
            "making personnel names and project details difficult to read.\n\n"
            "URL - https://op-intelligence.tools.qed42.net/planner?practice=Quality+Assurance\n\n"
            "---\n\n### **Requirement**\n\n"
            "Investigate and fix the layout issue causing allocation labels to overflow into the "
            "frozen left panel during horizontal/vertical scrolling. Allocation bars and their "
            "labels should remain confined to the timeline/grid area and should not overlap the "
            "Personnel section."
        ),
        issue_type="Task",
        status="To Do",
        priority="Medium",
        url="https://qed42-operations.atlassian.net/browse/QED42OPSIN-60",
    ),
    TaskContext(
        key="QED42OPSIN-59",
        project="QED42OPSIN",
        summary="Capacity Planner | Fix Capacity Planner Search Results",
        description=(
            "#### **User Story**\n\n"
            "As a Resource Manager/Project Manager, I want the Capacity Planner search to return "
            "accurate personnel and project results so that I can quickly locate allocations and "
            "plan capacity without incorrect or missing search results.\n\n"
            "---\n\n### **Background**\n\n"
            "The search functionality in the Capacity Planner is not returning the expected "
            "results. When searching for a project or personnel, the displayed allocations do not "
            "consistently match the search term. This makes it difficult for users to find the "
            "required resource allocations and impacts capacity planning activities.\n\n"
            "The attached screenshots demonstrate that the search results are not behaving as "
            "expected.\n\nURL - https://op-intelligence.tools.qed42.net/planner\n\n"
            "---\n\n### **Requirement**\n\n"
            "Investigate and fix the Capacity Planner search functionality to ensure it accurately "
            "filters and displays data based on the entered search term.\n\nThe search should:\n\n"
            "* Return matching personnel when searching by personnel name.\n"
            "* Return matching projects when searching by project name. For example, in the "
            "attached screenshot, when searching by project (AAO), it's showing irrelevant "
            "resources that aren't even currently allocated to the project.\n"
            "* Display only relevant allocations associated with the search.\n"
            "* Exclude unrelated personnel and projects from the results.\n"
            "* Maintain accurate search results regardless of applied filters (e.g., Practice, "
            "month, etc.)."
        ),
        issue_type="Task",
        status="To Do",
        priority="Medium",
        url="https://qed42-operations.atlassian.net/browse/QED42OPSIN-59",
    ),
    TaskContext(
        key="QED42OPSIN-51",
        project="QED42OPSIN",
        summary='Capacity Planner: "Create Allocations" permission on Project Manager role is not honoured',
        description=(
            "Context: A user was granted the Project Manager role so they could manage "
            "allocations in Capacity Planner. The 'Create Allocations' permission was added to "
            "the Project Manager role.\n\n"
            "Problem: Despite 'Create Allocations' being enabled on the role, the PM user was "
            "still unable to create allocations. It only worked after granting full Admin rights."
        ),
        issue_type="Bug",
        status="To Do",
        priority="Low",
        url="https://qed42-operations.atlassian.net/browse/QED42OPSIN-51",
    ),
    TaskContext(
        key="QED42OPSIN-54",
        project="QED42OPSIN",
        summary="Support per-user permission overrides on top of role-level permissions",
        description=(
            "Split out of QED42OPSIN-51. Support granting additional permissions to an "
            "individual user on top of their base role, so per-user exceptions do not require "
            "editing the shared role or escalating to Admin."
        ),
        issue_type="Task",
        status="To Do",
        priority="Medium",
        url="https://qed42-operations.atlassian.net/browse/QED42OPSIN-54",
        comments=[JiraComment(author="Anand Toshniwal", body="keep this one on hold.. do not start working on this one")],
    ),
]


def main():
    audit = AuditLog(DATA_DIR / "audit.log.jsonl")
    policy = AutonomyPolicy()

    audit.log("execution_run_started", {"candidate_count": len(CANDIDATES)})

    evaluations = evaluate_candidates(CANDIDATES, policy)
    audit.log(
        "execution_candidates_evaluated",
        {"evaluations": [{"key": e.task.key, "eligible": e.eligible, "reasons": e.reasons} for e in evaluations]},
    )

    for e in evaluations:
        print(f"{e.task.key}: eligible={e.eligible} -- {'; '.join(e.reasons)}")

    selection = select_task(CANDIDATES, policy)
    if selection.picked is None:
        audit.log("execution_no_eligible_task", {})
        print("\nNo eligible task. Stopping.")
        return 1

    task = selection.picked
    audit.log("execution_task_selected", {"key": task.key, "summary": task.summary})
    print(f"\nSelected: {task.key} — {task.summary}")

    repo = resolve_repo(task.project)
    if repo is None:
        print(f"No repo mapped for project {task.project}")
        return 1

    manager = WorktreeManager(repo.local_path)
    worktree_path = manager.create(name_hint=task.key.lower(), base_branch=repo.default_branch)
    audit.log("execution_worktree_created", {"path": worktree_path, "base_branch": repo.default_branch})
    print(f"Worktree created at: {worktree_path}")

    prompt = build_implementation_prompt(task, worktree_path)

    # Hand off to the orchestrator (this conversation) as structured JSON.
    handoff = {
        "task_key": task.key,
        "worktree_path": worktree_path,
        "repo_local_path": repo.local_path,
        "repo_full_name": repo.full_name,
        "default_branch": repo.default_branch,
        "branch_name": f"work-agent/{task.key.lower()}",
        "prompt": prompt,
    }
    handoff_path = DATA_DIR / "live_handoff.json"
    handoff_path.write_text(json.dumps(handoff, indent=2))
    print(f"\nHandoff written to {handoff_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
