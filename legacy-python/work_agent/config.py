from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Config:
    mode: str  # "mock" or "live"
    data_dir: Path
    lookback_hours: int = 24


def load_config(mode: str | None = None, data_dir: str | None = None, lookback_hours: int | None = None) -> Config:
    resolved_mode = mode or os.environ.get("WORK_AGENT_MODE", "mock")
    if resolved_mode not in ("mock", "live"):
        raise ValueError(f"Unknown mode {resolved_mode!r}; expected 'mock' or 'live'")

    resolved_data_dir = Path(data_dir or os.environ.get("WORK_AGENT_DATA_DIR", "data"))
    resolved_lookback = lookback_hours if lookback_hours is not None else int(
        os.environ.get("WORK_AGENT_LOOKBACK_HOURS", "24")
    )

    return Config(mode=resolved_mode, data_dir=resolved_data_dir, lookback_hours=resolved_lookback)
