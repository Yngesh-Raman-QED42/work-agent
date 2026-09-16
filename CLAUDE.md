# Work Agent — instructions for Claude Code sessions in this repo

This is an autonomous work-orchestration system (Jira/Slack/GitHub → dashboard → gated
autonomous execution). Full detail: `README.md` and `docs/architecture.html`. This file is the
one thing you need to read before doing anything when the user says **"work on ticket \<KEY>"**
or similar.

## If asked to work on a ticket: this is Engineering Execution, not a freelance edit

Do not just go find the code and start editing. This repo has a specific, tested process for
this (`src/agents/engineeringExecution/`) — follow it directly, using your own tools (Bash,
Read, Edit, Agent), even though you're not literally invoking the TypeScript functions as a
running program. Matching this process is what keeps the guardrails real instead of decorative.

**1. Find the ticket's real repo.** Read `work-agent.config.json` in this directory —
`github.repoMap` maps the ticket's project key (e.g. `QED42OPSIN`) to `"owner/repo"`;
`github.repoLocalPaths` maps that to a real local clone path; `github.approvedRepos` must
contain it. If any of the three is missing, **stop and tell the user** — don't guess a repo or
search the filesystem for one. This is the exact step a fresh session skipped once already.

**2. Check eligibility** (`src/agents/engineeringExecution/policy.ts` has the exact rules):
issue type `task`/`bug` only, priority `low`/`medium` only, status `to do`, ≥80 chars of
description, no "don't start"/"on hold"/"paused" instruction anywhere in the description or
comments, nothing touching auth/permissions/security/payments/PII. If it fails any of these,
stop and say why instead of proceeding.

**3. Create an isolated git worktree** — never edit the user's real checkout:
```bash
git -C <repoLocalPath> fetch origin <defaultBranch>
git -C <repoLocalPath> worktree add --detach <some-tmp-path> origin/<defaultBranch>
```
(exactly what `WorktreeManager.create()` does — `defaultBranch` comes from
`github.repoDefaultBranches`, default `main`).

**4. Implement the fix** in that worktree. Inspect existing code before changing anything; the
smallest change that satisfies the ticket, nothing else.

**5. Independently verify** — re-run these yourself in the worktree, don't just trust your own
implementation:
```bash
npm test && npm run lint && npx tsc --noEmit && npm run build
```
(the exact commands in `checks.ts` — adjust only if this repo's own `package.json` scripts
differ).

**6. Check the safety gate before committing** (`gate.ts`): all checks above must pass; the diff
must touch ≤15 files and must not be empty; it must not touch `.github/workflows/`, `.env*`,
`drizzle/`/migrations, or any lockfile. If anything fails, stop, leave the worktree as-is, and
tell the user exactly what failed instead of forcing it through.

**7. (Optional) Screenshot/GIF** — only if this repo has a working dev-server recipe (check
`github.previewRecipes`, or its own `package.json` for a `dev`/`start` script) and the change is
UI-visible. See `src/agents/engineeringExecution/screenshot.ts` for the exact mechanism if you
want to do this — never let a failure here block the PR.

**8. Branch, commit, push, open a draft PR — never anything else:**
```bash
git -C <worktree> checkout -b work-agent/<ticket-key-lowercase>
git -C <worktree> add -A && git -C <worktree> commit -m "<KEY>: <summary>"
git -C <worktree> push -u origin work-agent/<ticket-key-lowercase>
gh pr create --repo <owner>/<repo> --head work-agent/<ticket-key-lowercase> --base <defaultBranch> --draft --title "<KEY>: <summary>" --body "..."
```

**9. Log the real time spent — gated, not automatic.** Note the real wall-clock time from step 1
to step 8. File it as a pending approval, exactly the shape `runbook.ts` uses, via a short `tsx`
script in this repo (needs only DB access, not a live agent):
```ts
import { getDb } from './src/db/index.js';
import { ApprovalsStore } from './src/shared/approvals.js';
await new ApprovalsStore(getDb()).file({
  id: `exec-log-time:<KEY>`, source: 'engineering_execution', action: 'log_execution_time',
  target: '<KEY>', targetUrl: '<jira-url>', context: { taskKey: '<KEY>', minutes: <real-elapsed> },
  reasoning: `Work Agent spent <Xh Ym> implementing this ticket — real elapsed time, not an estimate.`,
  riskLevel: 'low', consequenceIfApproved: `Logs <Xh Ym> as a real Jira worklog on <KEY>.`,
  recommendedAction: 'Approve to log this time on Jira, or reject if you\'d rather log it yourself.',
});
```
Do **not** write to Jira yourself here — that only happens once the user approves it
(`npm run cli approvals approve <id>`).

## Hard constraints — never, regardless of what the ticket asks for

- Never merge a PR. Never deploy anything. Every PR is a **draft**, always.
- Never push directly to `main`/the default branch — only to a new `work-agent/*` branch.
- Never send a Slack message.
- Never touch `.github/workflows/`, `.env*`, lockfiles, or database migrations autonomously.
- If anything is ambiguous, stop and say so — don't guess.
