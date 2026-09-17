# Work Agent

Personal AI work orchestration system. TypeScript/Node.js/PostgreSQL, matching
the conventions already used in this codebase's real product
(`operational-intelligence`): Drizzle ORM + `pg`, `@electric-sql/pglite` for
dependency-free tests, Vitest, `typescript-eslint`, `tsx`. The original Python
prototype (Phases 1–2's first pass) lives in `legacy-python/` as reference;
its design carried over, its code did not.

## This is a general-purpose system, not project-specific

Nothing in `src/` has a project or repo name hardcoded anywhere. The Jira
query is `assignee = currentUser() AND statusCategory != Done` — no project
filter. `github.repoMap`/`repoLocalPaths`/`approvedRepos` in
`work-agent.config.json` are user-maintained data, not app defaults — an
unmapped project always means "stop and ask," never a guess. See
`tests/engineeringExecution/repoResolver.test.ts` and
`tests/orchestrator/index.test.ts`'s "brand new project" cases for the
regression tests that enforce this.

## Architecture

```
Central Orchestrator (src/orchestrator)
  1. Observation           — Slack/Jira/GitHub collect -> correlate -> classify -> briefing (Phase 1)
  2. Slack Intelligence    — classify messages into 8 categories, thread-aware, only persists real signal
  3. Task Intelligence     — for a detected assignment: fetch full Jira context, decide clear-enough-to-start
  4. Engineering Execution — policy -> worktree -> implement -> independently re-verify -> gate -> branch/commit/push -> draft PR (Phase 2)
                             optional screenshot + GIF capture (src/agents/engineeringExecution/screenshot.ts), opt-OUT per repo via config
  5. PR Monitoring         — classify review feedback, auto-fix straightforward stuff on the existing branch, escalate the rest (Phase 3)
Communication              — draft replies, risk-gated send, never auto-sends anything consequential (Phase 4)
Work Memory                — facts (from systems) vs. conclusions (from AI), timestamped, sourced
Work Log                   — projected from the audit log, never fabricated
Daily/End-of-Day/Weekly     — reporting agents over Work Log + approvals; weekly never invents hours
Human Approval              — ONE shared queue (src/shared/approvals.ts) every agent files into
Scheduler                   — persisted, restart-safe job state (src/scheduler) — not auto-started, see below
Dashboard + CLI              — read-only web view + `work-agent <command>`
```

## Guardrails, enforced structurally, not by convention

- No method anywhere merges a PR, deploys anything, or force-pushes.
- Every PR is opened as a draft by default (`config.engineeringExecution.openPrAsDraft`, default
  `true`) — flip it locally once you're ready to skip that step yourself; merging remains
  something this system never does, regardless of that flag.
- All autonomous file changes happen inside an isolated `git worktree`, never the caller's checkout.
- A consequential communication draft (commitment/deadline/decision/client/conflict/sensitive) is
  **never** auto-sent, regardless of config.
- Anything ambiguous (unmapped repo, sensitive keywords, explicit "hold" instructions, failing
  checks, an implementer that stops itself) goes to the approval queue, not a guess.
- Work Log/Weekly Summary only ever report what was actually logged — no invented hours, no
  invented activity.

## Running it

```bash
npm install
docker compose up -d           # dedicated Postgres on port 5433 — NOT 5432 (operational-intelligence's own)
cp .env.example .env
cp work-agent.config.json.example work-agent.config.json   # then fill in your own project/repo mapping
npx drizzle-kit generate       # only after a schema change
npm run db:migrate
npm link                       # one-time — makes the `work-agent` command below actually resolve

npm run cli run                        # observation cycle (mock mode by default)
npm run cli status                     # pending-approval counts
npm run cli approvals list             # full detail on each pending approval
npm run cli approvals approve <id>     # or `reject`
npm run cli end-of-day
npm run cli weekly-summary
npm run dashboard                      # http://localhost:4180 — read-only except the "Start" button below
npm run scheduler                      # NOT started automatically — see below

work-agent exec-start <TICKET_KEY>     # Engineering Execution, part 1 — see "Working a ticket" below
work-agent exec-finish <TICKET_KEY> --summary "..."    # part 2, after you've implemented it
# (equivalently: npm run cli -- exec-start <TICKET_KEY>, if you skipped npm link)
```

### Working a ticket — exec-start / exec-finish, not a hand-run checklist

Engineering Execution is deliberately split into two CLI commands around the one step that
genuinely needs a live coding agent (spawning a subagent only works from a live Claude Code
session — never from a plain script; an unattended `claude -p --permission-mode
bypassPermissions` subprocess was tried and is blocked by this environment's own safety
classifier). Everything on either side of that step is real, tested, deterministic code — not a
prose process for a session to reconstruct by hand each time (see `CLAUDE.md`, which is what a
live session actually reads).

1. `exec-start <KEY>` — resolves the repo from config, checks eligibility, creates the isolated
   worktree off the correct base branch, prints the implementation prompt. Persists everything
   `exec-finish` needs as `.work-agent/execution-state.json` inside the worktree itself (see
   `src/agents/engineeringExecution/executionState.ts`) — no database schema needed for the
   handoff. Also moves the Jira ticket to whatever "in progress"-equivalent status its own
   workflow currently offers (`IN_PROGRESS_STATUS_CANDIDATES` in `runbook.ts` — tried in order,
   first one the real workflow has wins; never forces one that doesn't exist).
2. You (or the live session) implement the fix in that worktree.
3. `exec-finish <KEY> --summary "..."` — independently re-verifies, checks the gate (retrying each
   check up to twice more on failure first — see "Known simplifications" below), captures a
   screenshot/GIF if you wrote the steps file, branches/commits/pushes, opens the PR, posts a Jira
   comment linking the PR, moves the ticket to whatever "in review"-equivalent status is available
   (`IN_REVIEW_STATUS_CANDIDATES`), and files the real-elapsed-time approval. All of the Jira
   writes are best-effort (`src/integrations/jira/issueUpdater.ts`) — a Jira hiccup never undoes or
   blocks a PR that's already open. If you had to stop early: `exec-finish <KEY> --failed "..."`
   instead, which correctly stops the pipeline rather than leaving it half-done.

Both commands print real-time progress to the terminal as each stage happens (`onProgress` in
`runbook.ts`) — `exec-finish` in particular can run for several minutes (independently re-running
the full test suite, then booting a real dev server for screenshots), and a silently frozen
terminal for that long is indistinguishable from a hang. The dashboard (`npm run dashboard`,
`http://localhost:4180`) reflects the same underlying `execution_tasks` row too, live on refresh —
useful to have open in a second tab while a long run is in progress.

`runExecution()` (the original single-call function, used by tests and the orchestrator when a
real `ClaudeCodeRunner` is already available) is unchanged — it's just `startExecution()` →
`claudeRunner.run()` → `finishExecution()` wired together internally, not a different code path.

### The dashboard's "Start" button

Every ticket card has a "▶ Start" button — it's the same thing as opening a terminal, `cd`-ing
into this repo, and running `claude "work on task <KEY>"` by hand, just automated. This is
different from (and not blocked by) the unattended-agent restriction above: it opens a real,
interactive `claude` session in a real terminal window on your own machine — nothing runs headless.
The dashboard is a local Node process, not a hosted web app, so the button's backend
(`POST /start-task` in `server.ts`) has normal OS-level privileges to spawn that terminal directly.

Which terminal-launch command it uses is a per-machine fact, set via `dashboard.terminalOs` in
`work-agent.config.json` — `"ubuntu"` (default), `"mac"`, or `"windows"` (see
`src/dashboard/launchSession.ts` for the exact command each one runs; Windows is best-effort,
unverified against a real Windows machine). The button itself doesn't decide whether a ticket is
actually eligible for autonomous work — it just starts the session; `exec-start`'s own policy check
still has the final say once you ask it to work on the ticket.

Tests (no Docker needed — pglite is in-memory):

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

## Configuring `work-agent.config.json`

Every field is keyed by Jira project key or `"owner/repo"` — nothing is inferred, an unmapped
project always means "stop and ask" (see above). This file is per-person and gitignored on
purpose (`work-agent.config.json.example` is what actually ships) — your local clone paths and
test accounts aren't the same as a teammate's. Here's what each field is for, with a worked
example:

- **`github.approvedRepos`** — an explicit allowlist. A repo not in this array is never touched
  by Engineering Execution, even if `repoMap` below resolves to it. You opt in per repo, on
  purpose — nothing is ever inferred from "a ticket looked like it belonged here."
  ```json
  "approvedRepos": ["your-org/your-repo"]
  ```

- **`github.repoMap`** — Jira project key → `"owner/repo"`. How a ticket like `PROJ-56` gets
  matched to an actual GitHub repo.
  ```json
  "repoMap": { "PROJ": "your-org/your-repo" }
  ```

- **`github.repoLocalPaths`** — `"owner/repo"` → where that repo is cloned **on your own
  machine**. This is exactly why the file is per-person: your clone lives somewhere different
  from a teammate's.
  ```json
  "repoLocalPaths": { "your-org/your-repo": "/Users/you/code/your-repo" }
  ```

- **`github.repoDefaultBranches`** — the branch a worktree is built off *and* the PR targets.
  **Don't assume this is GitHub's own "default branch" setting** — check what your team's real
  feature PRs actually target (`gh pr list --state all --json baseRefName`). A repo's technical
  default can be `main` while every real feature branch is based on and merged into
  `development`, with `main` reserved for releases — exactly that mismatch caused a real PR to
  target the wrong branch once already.
  ```json
  "repoDefaultBranches": { "your-org/your-repo": "main" }
  ```

- **`github.previewRecipes`** *(optional)* — how to boot that repo's own dev server for the
  Engineering Execution screenshot/GIF step. You can leave this out entirely: it auto-detects
  from the repo's own `package.json` (`npm run dev`, port 3000). You only need an entry here to
  override the command/port, to disable it for one repo (`"your-org/your-repo": false`), or to
  add a test-login for an app that requires signing in:
  ```json
  "previewRecipes": {
    "your-org/your-repo": {
      "startCommand": ["npm", "run", "dev"],
      "port": 3000,
      "readyPath": "/",
      "testLogin": {
        "emailSelector": "input[name=\"email\"]",
        "email": "your-test-account@example.com",
        "submitSelector": "text=Sign in (test)"
      }
    }
  }
  ```
  `testLogin` only applies to an app with its own dev-mode auth bypass (like op-intelligence's
  "Test Environment Bypass" on `/login`) — give it the real selector and a real test account your
  app actually accepts, so the implementer never has to guess at one blind.

  Two more gitignored things a fresh worktree doesn't have that a real dev server can need, both
  handled automatically, worth knowing about if screenshots still fail to boot:
  - `.env`/`.env.local` are copied from the primary checkout into every worktree
    (`WorktreeManager.copyEnvFiles`) — an app that reads `DATABASE_URL` or similar at boot
    otherwise fails or errors on every request, which looks identical to "dev server never became
    ready" from the outside.
  - `node_modules` is normally symlinked from the primary checkout for speed (see below), but
    Turbopack (Next.js's dev bundler) refuses to resolve a package through a symlink that leads
    outside the project directory — `[project]/node_modules is invalid, it points out of the
    filesystem root`. Right before booting the preview server specifically,
    `materializeRealNodeModules` swaps the symlink for a real `npm ci`/`install` (with
    `--legacy-peer-deps --ignore-scripts`, since a fresh install can re-surface a peer conflict an
    already-installed checkout tolerated), never touching package-lock.json. Every check
    (test/lint/typecheck/build) already ran fine before this point — this only matters for
    Turbopack/webpack-style dev servers specifically.
  - The spawned preview server never inherits Work Agent's own env vars (`DATABASE_URL`,
    `JIRA_*`, `SLACK_*`, `GITHUB_TOKEN`, etc. — see `WORK_AGENT_OWN_ENV_KEYS` in `screenshot.ts`).
    Without this, Work Agent's own already-set `DATABASE_URL` silently wins over the target app's
    own copied `.env` (an already-set process env var always beats one loaded from a `.env` file),
    pointing the target app at Work Agent's database instead of its own — every page then 500s
    against a schema that doesn't match, which again looks identical to a readiness problem from
    the outside. Confirmed as the real cause of a live failure, not a hypothetical.

  `readyTimeoutMs` (default 60s when auto-detected) is how long to wait for the dev server to come
  up before giving up on screenshots for that run. Every worktree is a cold checkout with no build
  cache of its own (no `.next`, no `.turbo` — same reason `node_modules` needs handling; see
  `WorktreeManager.ensureDependencies`), so a framework's very first compile in a fresh worktree is
  often much slower than the same app already running in your primary checkout. Set this generously
  (2+ minutes for a real Next.js app) — too low and every screenshot attempt fails with "dev server
  did not become ready," never a partial/blurry capture, since `runChecks`/the PR itself are
  unaffected either way (screenshot failure is always best-effort, never gates the PR).

- **`jira.ignoredKeys`** — the one deliberate exception to "everything assigned to you shows up."
  Every ticket assigned to you appears on the dashboard by default, with no allowlist — this is
  purely an opt-*out*, for a specific ticket you already know about and don't want cluttering it.
  Filtered out before correlation or classification ever runs, so it never even becomes a work
  item, not just hidden in the UI.
  ```json
  "ignoredKeys": ["PROJ-999"]
  ```

- **`jira.myProjects`** and **`slack.relevantChannels`** — reserved for future filtering; safe to
  leave as `[]`. Observation already pulls every ticket assigned to you and every Slack message
  that mentions you or links to one of your tickets, with no allowlist required.

- **`engineeringExecution.openPrAsDraft`** *(default `true`)* — whether `exec-finish` opens a
  draft PR or a real one. Set `false` once you're ready to skip the draft step yourself; merging
  remains something this system never does either way, regardless of this flag.
  ```json
  "engineeringExecution": {
    "openPrAsDraft": false
  }
  ```

- **`dashboard.terminalOs`** *(default `"ubuntu"`)* — which terminal-launch command the
  dashboard's "▶ Start" button uses (see "The dashboard's Start button" above). A per-machine
  fact — set it to whatever you actually run this on.
  ```json
  "dashboard": {
    "terminalOs": "mac"
  }
  ```

## What's NOT wired to run unattended, and why

- **The scheduler** (`npm run scheduler`) is real, tested, and restart-safe (state lives in
  Postgres, not memory), but nothing in this codebase starts it automatically. Standing up
  actual recurring automation is a deliberate decision for you to make, not something to
  silently enable.
- **Engineering Execution's implementer step** needs a live, properly-permissioned coding agent
  (see `agents/engineeringExecution/claudeRunner.ts`) — an unattended `claude -p
  --permission-mode bypassPermissions` subprocess was tried and blocked by this environment's own
  safety classifier. The correct live path is the orchestrating Claude Code session spawning a
  scoped subagent itself, which is what actually happened in this session's real PR (see below).
  `runOrchestratorCycle`/`runExecution` accept an injected `ClaudeCodeRunner` for exactly this
  reason — there's no unattended "Live" implementation to fake.

## Live-mode credential gaps

- **Jira**: needs `JIRA_BASE_URL`/`JIRA_EMAIL`/`JIRA_API_TOKEN` — not yet provisioned (the Jira
  access used elsewhere in this environment is a live Claude Code MCP session, not a portable
  token). `fetchIssueDetail` (used by Task Intelligence) is implemented and ready once it is.
- **GitHub**: works today. Shells out to the `gh` CLI (real org access) rather than the GitHub
  MCP plugin's PAT, which is scoped to personal repos only.
- **Slack reading**: needs `SLACK_USER_TOKEN`/`SLACK_USER_ID` — a **user** token (xoxp-), not a
  bot token (earlier guidance in this README said bot token; that was wrong — Slack's search API
  only works with a user token, and a bot can't see your DMs with other people at all). Only
  needed if you want the scheduler gathering Slack data unattended; not needed if Slack activity
  only gets gathered while chatting with a live Claude Code session, which already has read
  access today via the OAuth connection completed this session.
- **Slack sending**: separate, optional, off by default (`config.communication.autoSendRoutine`).
  Needs its own `SLACK_BOT_TOKEN` scoped to only `chat:write` — deliberately a narrower,
  different credential from the reading one, so it can never read anything. Not required at all;
  the project's current stance is no automated Slack sending, period.

## Known simplifications (stated, not hidden)

- PR Monitoring can't see per-thread "resolved" state (`gh pr view` doesn't expose it without a
  separate GraphQL query) — every comment is treated as unresolved each run. Idempotent, not
  unsafe, just occasionally re-classifies something already handled.
- Weekly Summary can currently only group by ticket when an event's audit details include a
  `key` field (only task-selection does today) — most events don't yet carry a Jira/project tag.
  Stated in the generated summary itself, not glossed over.
- Communication and Work Memory (`src/agents/communication`, `src/agents/workMemory`) exist as
  real, tested modules but aren't called from anywhere in the live flow — not the Orchestrator,
  not the CLI, not the scheduler. They're capabilities-in-waiting, not part of what actually runs
  today; don't describe them as active in anything user-facing until they're actually wired up.
- Screenshot capture in Engineering Execution (`src/agents/engineeringExecution/screenshot.ts`)
  needs `npx playwright install chromium` run once (browser binary isn't installed by `npm
  install` alone). It's opt-OUT, not opt-in: any approved repo gets a best-effort attempt using
  an auto-detected recipe (its own package.json "dev"/"start" script, port 3000) unless
  `github.previewRecipes[repo]` is explicitly set to `false`, or a real recipe object overrides
  the command/port/env — e.g. a `testLogin` entry when the app needs signing in to reach a
  meaningful page. Everything else (test/lint/typecheck/build, the safety gate) runs identically
  with or without it, and capture failing never blocks a PR.
- When 2+ screenshot steps are captured, an animated GIF ("feature-in-action.gif", assembled from
  the same frames via `gifenc`/`pngjs`, both pure-JS with no native deps) is embedded above the
  individual stills in the PR body — a quick "see it in action" preview, not a screen recording.
- Screenshots/GIFs never ship as files in the code PR's own diff. They're published to a
  standalone `work-agent/screenshots/<key>` branch via git plumbing (`GitOps.publishAssetBranch`
  — `git hash-object`/`mktree`/`commit-tree`, pushed as its own ref; never touches the code
  branch's working tree, index, or commit history) and linked into the PR description via
  `github.com/OWNER/REPO/raw/REF/PATH` — deliberately **not**
  `raw.githubusercontent.com/OWNER/REPO/REF/PATH`. The latter is a separate, cookie-less origin
  that requires its own bearer token; a viewer's browser rendering a PR's `![]()` image never
  sends one, so it 404s for anyone on a private repo regardless of their GitHub permissions
  (confirmed against a real private repo). The `github.com/.../raw/...` alias is same-origin with
  the PR page itself, so it authenticates via the viewer's normal github.com session. The PR diff
  is code only; the images live only in the description.
- Booting the real dev server for screenshots can make the target app itself write to disk as a
  side effect (a runtime cache, a generated file — op-intelligence's own avatar-image route did
  exactly this) — none of that is part of the implementer's actual change. `finishExecution` snapshots
  untracked files right before capture and removes anything new right after, so only the
  implementer's real diff reaches the eventual commit. Work Agent's own bookkeeping under
  `.work-agent/` (execution-state.json, the screenshot steps file) is removed unconditionally
  before every commit, whether or not a screenshot was even attempted.
