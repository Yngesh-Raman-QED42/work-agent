# Work Agent — instructions for Claude Code sessions in this repo

This is an autonomous work-orchestration system (Jira/Slack/GitHub → dashboard → gated
autonomous execution). Full detail: `README.md` and `docs/architecture.html`. This file is the
one thing you need to read before doing anything when the user says **"work on ticket \<KEY>"**,
**"estimate task \<KEY>"**, or similar.

## If asked to work on a ticket: run the real commands, don't freelance it

**Use exactly these two CLI commands.** They are real, tested code (`src/agents/engineeringExecution/`,
`tests/engineeringExecution/`) — not a checklist for you to reconstruct by hand. A prose
description of a 9-step process, read fresh each time, is exactly how steps get skipped,
reordered, or half-done. These two commands can't skip a step; they either run it or don't
compile.

```bash
work-agent exec-start <TICKET_KEY>
```
This alone: reads `work-agent.config.json` for the repo mapping (never guesses, never searches
the filesystem for a checkout — if the mapping is missing it tells you and stops), checks
eligibility against the real autonomy policy, creates an isolated git worktree off the *correct*
base branch from config, and prints the exact worktree path plus the implementation prompt. If
the ticket isn't eligible, it says why and stops — nothing else happens.

**Then implement the fix yourself**, directly, in that exact worktree path — inspect existing
code first, smallest change that satisfies the ticket, nothing else. This is the one step that
genuinely can't be a script: it needs you, actually reasoning about the code. If the change is
UI-visible and the prompt told you a screenshot recipe is available, write
`.work-agent/screenshot-steps.json` in the worktree as instructed in the prompt — the next
command picks it up automatically, you don't have to invoke the screenshot mechanism yourself.

```bash
work-agent exec-finish <TICKET_KEY> --summary "<what you changed and why>"
```
This alone does everything else, in order, automatically: independently re-runs
tests/lint/typecheck/build (never trusts your own claim), checks the safety gate (diff ≤15
files, no forbidden paths), captures the screenshot/GIF if you wrote the steps file, then
branches, commits, pushes, and opens the PR (draft or real, per
`config.engineeringExecution.openPrAsDraft`), then files the real-elapsed-time approval. **Do
not** hand-write any of this yourself, and do not edit anything under `src/` in *this* repo to
make it happen — that's already-built, already-tested code; running it is the whole point. If
you got stuck instead of finishing, run `work-agent exec-finish <KEY> --failed "<why>"` instead —
that correctly stops the pipeline and files the right approval, rather than you leaving it
half-done or trying to patch around it.

If either command errors or behaves unexpectedly, **stop and tell the user** what it actually
said — don't work around it by doing the step manually instead.

## If asked to estimate a ticket: read deeply, stay read-only

When asked to **estimate task \<KEY>** (a distinct, separate request from "work on" — triggered by
the dashboard's "⏱ Estimate" button, or asked directly), this is investigation only. Never write
code, never create a branch or worktree, never open a PR, never log time or post a comment
anywhere. Just read, reason, and report back in this session's own output — nothing about an
estimate is written to Jira, the dashboard's database, or GitHub yet (deliberately deferred until
the estimation approach itself is proven good).

1. Fetch the full ticket — summary, description, every comment, and its current status.
2. Follow every link: sub-tasks, "relates to"/"blocks"/"is blocked by" issues, and the epic it
   belongs to if any. Read enough of each to understand what this ticket actually depends on, not
   just its own title.
3. Look at the real codebase (the repo mapped in `work-agent.config.json` for this ticket's
   project) to judge actual complexity — how many files/systems are likely touched, whether it
   needs a new external service/API integration, a schema migration, a new dependency, or an
   unfamiliar area of the code. Don't estimate blind from the title alone.
4. **Calibrate development time to how this will actually be implemented: AI-assisted (this
   system's own `exec-start`/`exec-finish` flow), not manual line-by-line human coding.** An AI
   implementation of a well-scoped change is typically much faster than a human writing it by
   hand — but real wall-clock time still goes into: the AI iterating if checks/the gate fail,
   further rounds if the fix isn't right the first time, and a human actually reading and
   reviewing the diff before it merges. Don't estimate this as if you were the one hand-typing the
   code over hours or days; don't estimate it as instantaneous either.
5. Give one estimate that covers the *whole* lifecycle, each part called out separately:
   AI-assisted development (plus iteration), your review, QA, and deployment — then a total.
6. Add a buffer on top of your honest number, and lean generous. **A bad estimate is worse than a
   late completion.** State the buffer as its own line, and say briefly what's driving it (an
   unclear dependency, no existing test coverage in that area, an area you're less confident
   about, etc.).
7. Report it directly in this session — a short breakdown, a total, and the 2-3 biggest sources of
   uncertainty behind the buffer. That's the whole deliverable for now.

## Hard constraints — never, regardless of what the ticket asks for

- Never merge a PR. Never deploy anything.
- Never push directly to the default/base branch — only to a new `work-agent/*` branch.
- Never send a Slack message.
- Never touch `.github/workflows/`, `.env*`, lockfiles, or database migrations autonomously.
- Never modify this repo's own source (`src/`, `tests/`) as a side effect of working a ticket —
  if something here seems broken, tell the user, don't patch around it inline.
- If anything is ambiguous, stop and say so — don't guess.
