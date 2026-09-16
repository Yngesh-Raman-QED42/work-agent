from __future__ import annotations

from typing import List

from ..models import SlackMessage


class MockSlackConnector:
    """Fixture data for tests/dry-runs. Never touches a real workspace."""

    def __init__(self, messages: List[SlackMessage] | None = None):
        self._messages = messages if messages is not None else default_fixture_messages()

    def fetch_relevant_messages(self, *, lookback_hours: int = 24) -> List[SlackMessage]:
        return list(self._messages)


def default_fixture_messages() -> List[SlackMessage]:
    return [
        SlackMessage(
            channel="C01ENG",
            channel_name="#eng-capacity-planner",
            ts="1725870000.000100",
            user="U01ALICE",
            text="@you can you double check QED42OPSIN-59 before standup? search results still look off",
            permalink="https://example.slack.com/archives/C01ENG/p1725870000000100",
            mentions_me=True,
        ),
        SlackMessage(
            channel="C02QA",
            channel_name="#qa-handoff",
            ts="1725873600.000200",
            user="U02BOB",
            text="QED42OPSIN-56 export button is passing QA, moving to Ready for Release",
            permalink="https://example.slack.com/archives/C02QA/p1725873600000200",
            mentions_me=False,
        ),
        SlackMessage(
            channel="C01ENG",
            channel_name="#eng-capacity-planner",
            ts="1725877200.000300",
            user="U03CARL",
            text="anyone free to review PR #42 on capacity-planner? small one",
            permalink="https://example.slack.com/archives/C01ENG/p1725877200000300",
            mentions_me=False,
        ),
        SlackMessage(
            channel="C03RANDOM",
            channel_name="#random",
            ts="1725880800.000400",
            user="U04DAVE",
            text="lunch at 1pm today?",
            permalink="https://example.slack.com/archives/C03RANDOM/p1725880800000400",
            mentions_me=False,
        ),
    ]
