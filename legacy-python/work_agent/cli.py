from __future__ import annotations

import argparse
import sys

from .config import load_config
from .connectors.mock_github import MockGitHubConnector
from .connectors.mock_jira import MockJiraConnector
from .connectors.mock_slack import MockSlackConnector
from .pipeline import run_pipeline


def build_connectors(mode: str):
    if mode == "mock":
        return MockSlackConnector(), MockJiraConnector(), MockGitHubConnector()

    # mode == "live": read-only real connectors. Imported lazily so `requests`
    # (and real credentials) are only required when live mode is actually used.
    from .connectors.live_github import LiveGitHubConnector
    from .connectors.live_jira import LiveJiraConnector
    from .connectors.live_slack import LiveSlackConnector

    return LiveSlackConnector(), LiveJiraConnector(), LiveGitHubConnector()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="work-agent", description="Phase 1 observation & reporting pipeline")
    parser.add_argument("command", choices=["run"], help="Pipeline command to run")
    parser.add_argument("--mode", choices=["mock", "live"], default=None, help="Defaults to $WORK_AGENT_MODE or 'mock'")
    parser.add_argument("--data-dir", default=None, help="Defaults to $WORK_AGENT_DATA_DIR or ./data")
    parser.add_argument("--lookback-hours", type=int, default=None)
    args = parser.parse_args(argv)

    config = load_config(mode=args.mode, data_dir=args.data_dir, lookback_hours=args.lookback_hours)
    slack, jira, github = build_connectors(config.mode)

    result = run_pipeline(config, slack, jira, github)

    print(result.briefing)
    print(f"[briefing written to {result.briefing_path}]")
    print(f"[approval queue ({len(result.approval_queue)} items) written to {result.approval_queue_path}]")
    print(f"[audit log appended at {result.audit_path}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
