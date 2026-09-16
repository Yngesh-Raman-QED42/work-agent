# Work Agent — Phase 1: Observation & Reporting

Read-only pipeline. Nothing in this codebase writes to Slack, Jira, or GitHub —
Phase 1 only collects, correlates, classifies, and reports.

## Pipeline

`SlackConnector` + `JiraConnector` + `GitHubConnector`
&rarr; `correlate()` (group by Jira key found in PR titles/branches and Slack text)
&rarr; `classify()` (rule-based category + urgency)
&rarr; `StateStore` (local JSON snapshot, diffed against the previous run)
&rarr; `generate_briefing()` (markdown) + `generate_approval_queue()` (pending-approval action list, nothing executed) + `AuditLog` (append-only JSONL)

## Run it

```bash
# mock data, no credentials needed
python3 -m work_agent.cli run --mode mock

# live data (read-only) — see env vars below
python3 -m work_agent.cli run --mode live
```

Output lands in `./data/` (overridable with `--data-dir` or `$WORK_AGENT_DATA_DIR`):
- `data/briefings/<date>.md` — the morning briefing
- `data/approval_queue.json` — proposed actions, all `status: pending_approval`
- `data/state.json` — last run's snapshot, used to compute new/changed/resolved
- `data/audit.log.jsonl` — append-only log of every pipeline step

## Live mode credentials (optional, read-only)

| Var | Needed for |
|---|---|
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Live Jira (token from id.atlassian.com/manage-profile/security/api-tokens) |
| `GITHUB_PERSONAL_ACCESS_TOKEN` (or `GITHUB_TOKEN`) | Live GitHub — already set in this environment |
| `SLACK_USER_TOKEN`, `SLACK_USER_ID` | Live Slack (xoxp- token with `search:read`) |

Only Jira and GitHub have real credentials available in this environment right
now; Slack live mode needs a token that isn't provisioned yet (the Slack MCP
connection used elsewhere in this environment is OAuth-proxied and not a
portable token a standalone script can reuse).

## Tests

```bash
python3 -m unittest discover -s tests -t . -v
```

All tests run against `Mock*Connector`s — no network calls, no real credentials required.
