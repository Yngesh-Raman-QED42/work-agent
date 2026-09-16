from __future__ import annotations

from .models import TaskContext


def build_implementation_prompt(task: TaskContext, worktree_path: str) -> str:
    comments_block = "\n".join(f"- {c.author}: {c.body}" for c in task.comments) or "(no comments)"
    return f"""You are implementing exactly one Jira ticket in an isolated git worktree. Follow this order strictly:

1. INSPECT FIRST. Read the relevant existing code before changing anything. Do not
   guess at file locations — search the codebase for the feature area described below.
2. Implement the smallest change that satisfies the acceptance criteria below. Do not
   expand scope, refactor unrelated code, or "improve while you're in there."
3. After implementing, run the project's test suite, lint, typecheck, and build
   (check package.json scripts) and fix any failures your change introduced.

Hard constraints:
- Your working directory is {worktree_path} — never touch any path outside it.
- Do NOT run any git command that mutates history or refs: no `git commit`, `git push`,
  `git checkout -b`, `git reset`, `git rebase`. Read-only git (status/diff/log) is fine
  for your own situational awareness. Committing and pushing is handled by the
  orchestrator after your work is reviewed, not by you.
- Do NOT touch CI config (.github/workflows), environment files (.env*), lockfiles
  (package-lock.json etc.), or database migrations — if the task genuinely requires
  changing one of those, STOP and explain why instead of making the change.
- Do NOT send any Slack message, do NOT call any Jira/GitHub write API, do NOT deploy
  anything, do NOT merge anything. You have no credentials for any of that here anyway.
- If the ticket is ambiguous, or the fix requires a product/design decision you can't
  make from the ticket text alone, STOP and clearly say so instead of guessing.

Ticket: {task.key} ({task.issue_type}, priority {task.priority})
URL: {task.url}

Summary: {task.summary}

Description:
{task.description}

Comments:
{comments_block}

When you're done (or if you stopped early), give a final summary of exactly what you
changed and why, and confirm the test/lint/typecheck/build results.
"""
