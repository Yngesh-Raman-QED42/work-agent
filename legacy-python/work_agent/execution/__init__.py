"""Work Agent — Phase 2: autonomous engineering execution.

Guardrails enforced by construction, not just convention:
  - No method anywhere in this package merges a PR.
  - No method anywhere in this package deploys anything.
  - No method anywhere in this package sends a Slack message.
  - Every PR this package creates is opened as a draft.
  - All file modification happens inside an isolated git worktree, never on
    the caller's primary checkout.
  - Any policy/ambiguity failure stops the run and files an approval-queue
    entry instead of proceeding.
"""
