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
eligibility against the real autonomy policy, brings the project's local backend up to date if
the repo has a `github.backendSync` entry (e.g. latest dev pull + containers started), removes
screenshot asset branches of PRs that are already merged/closed, creates an
isolated git worktree off the *correct* base branch from config, and prints the exact worktree
path plus the implementation prompt. If the ticket isn't eligible, it says why and stops — nothing
else happens.

**Then implement the fix yourself**, directly, in that exact worktree path — inspect existing
code first, smallest change that satisfies the ticket, nothing else. This is the one step that
genuinely can't be a script: it needs you, actually reasoning about the code. If the change is
UI-visible and the prompt told you a screenshot recipe is available, write
`.work-agent/screenshot-steps.json` in the worktree as instructed in the prompt — the next
command picks it up automatically, you don't have to invoke the screenshot mechanism yourself.

**Then review your own change with `/code-review` before finishing.** Point it explicitly at
the worktree (this session's own directory is the work-agent repo, so a bare `/code-review`
reviews the wrong code), e.g. `/code-review <worktree path> (review the uncommitted changes,
git diff HEAD plus untracked files, excluding .work-agent/, run inside that directory)`. Fix every real finding, re-run
the project's checks, and record the outcome in `.work-agent/code-review.json` as
`{"findings":[{"summary":"...","outcome":"fixed"|"not_fixed","reason":"why, if not_fixed"}]}`
(an empty array if it found nothing). `exec-finish` refuses to open a PR without that file
(status `stopped_needs_code_review`, nothing committed or filed), so just add it and re-run.
If an attempt stops on failed checks or the gate, the record is discarded: once you've changed
the code, review again before re-running. The automated PR-feedback fixer
(`monitorPr`) follows the same rule and won't push a fix without a review.

```bash
work-agent exec-finish <TICKET_KEY> --summary "<what you changed and why>"
```
This `--summary` text goes verbatim into the PR description and the Jira comment — write it the
way a person would describe their own change (what changed, why), never as a report about an AI
having done it. No "I implemented this using...", no mentioning Claude/an agent/automation at
all — it should read exactly like any other engineer's PR/commit summary.

This alone does everything else, in order, automatically: confirms the code review above was
recorded, independently re-runs
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

## Any other change that becomes or updates a PR: `/code-review` first

The same rule applies outside `exec-start`/`exec-finish`, for every project: resolving PR review
comments, follow-up fixes on an open PR, or a change done by hand because the pipeline couldn't
take it. Before pushing (or opening the PR), run `/code-review` on exactly what you're about to
push, pointed explicitly at that checkout and base, e.g. `/code-review <checkout path> (review
git diff origin/<base>...HEAD plus uncommitted changes, run inside that directory)`. Fix every
real finding, re-run the checks, then push. When you reply to the reviewer, mention only what
changed, never the tool.

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

## If asked to log time: `work-agent log-day`, and the rules are already decided

The person only tells you **what** they worked on, per day: tickets, rough hours for some of
it, or a vague "mostly PR reviews". They should never have to repeat **how** to log it. These
rules always apply, unasked:

- Every working day adds up to a little over 8h, never exactly 8h, and differently each day.
  The tool picks a random total between 8h05 and 8h55, counting anything already in Jira that day.
- Durations the person gives ("2h on QGP-487", "30 min DSM") are fixed. Everything else is
  "flex": leave `minutes` off, set a rough `weight` for its share, and the tool fills the rest of the
  day with jitter, so no two days split the same way.
- Every entry gets a real description (12+ words): which PR/feature, what was actually done
  (reviewed X against Figma, re-checked fixes, tested Y, merged Z), and the outcome. Never just a
  label like "DSM" or "PR review". Write as the person; no mentions of AI, Claude or automation,
  and no em dashes (commas and periods instead).
- Entries are laid out one after another through the day (from about 10:00), not stacked at one time.

**Fill in what they don't remember from evidence, not guesses:**
- PR reviews: the person's review and comment timestamps per day (convert to IST, +0530) on the
  repos they review, e.g. `gh api repos/<repo>/pulls/<n>/reviews` and `/comments`, filtered to
  their login. Log each PR review on that PR's own Jira ticket (the key in the PR title; for a PR
  covering several, the first one), describing what that day's pass covered (first review,
  re-check of fixes, approval).
- Their own PRs: commits, review rounds, merges and base changes per day (`gh api
  repos/<repo>/issues/<n>/timeline`, `/pulls/<n>/commits`), logged on each PR's ticket.
- Already logged: the tool reads Jira itself, and past entries (same JQL as
  `LiveJiraWorklogReader`) show the person's usual tickets and description style.

**Recurring tickets** (confirm a key's summary in Jira before using it): `UNLSD-10` UNLSD daily
standup (DSM) and UNLSD peer/team calls, usually 30m for DSM; `QGP-486` JavaScript team meeting,
about 1h a day, varied (45m to 1h15); `QGP-487` team / engineering practice meeting; `QDP-123`
Fun Friday. When the person groups things ("4 to 5h of UNLSD including DSM and peer calls"), keep
that group's total inside the range they gave.

**Steps:**
1. Write the plan in the session scratchpad, all days in one file:
   `{"days":[{"date":"2026-11-24","entries":[{"ticket":"QGP-487","minutes":120,"note":"..."},{"ticket":"UNLSD-103","weight":2,"note":"..."}]}]}`
2. `work-agent log-day <plan.json>` previews: it checks the rules, reads what's already in Jira,
   works out the minutes and start times, prints the days and saves them into the file. Fix
   anything it refuses (short description, weekend, overfull day) and preview again.
3. `work-agent log-day <plan.json> --apply` logs exactly the preview to Jira (and the local
   record). It marks each entry as it goes, so a failed run can be re-run without double logging.
   When the person asked you to log time, apply straight after the preview; ask first only if
   something is genuinely unclear (which ticket, or a day with no evidence and nothing said about it).
4. Report each day's entries and total.

## Hard constraints — never, regardless of what the ticket asks for

- Never merge a PR. Never deploy anything.
- Never push directly to the default/base branch — only to a new `work-agent/*` branch.
- Never send a Slack message.
- Never touch `.github/workflows/`, `.env*`, lockfiles, or database migrations autonomously.
- Never modify this repo's own source (`src/`, `tests/`) as a side effect of working a ticket —
  if something here seems broken, tell the user, don't patch around it inline.
- If anything is ambiguous, stop and say so — don't guess.
