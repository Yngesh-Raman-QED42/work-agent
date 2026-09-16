"""Work Agent — Phase 1: observation and reporting layer.

Read-only by design: no connector in this package writes to Slack, Jira, or
GitHub. Collection -> correlation -> classification -> local state ->
briefing/approval-queue/audit output.
"""

__version__ = "0.1.0"
