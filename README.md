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
- Every PR is opened as a draft.
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

npm run cli run                        # observation cycle (mock mode by default)
npm run cli status                     # pending-approval counts
npm run cli approvals list             # full detail on each pending approval
npm run cli approvals approve <id>     # or `reject`
npm run cli end-of-day
npm run cli weekly-summary
npm run dashboard                      # http://localhost:4180, read-only
npm run scheduler                      # NOT started automatically — see below
```

Tests (no Docker needed — pglite is in-memory):

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

30 test files / 171 tests. Includes real git-worktree/branch/commit/push plumbing against
throwaway scratch repos (never a real project), and a full orchestrator wiring test.

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
