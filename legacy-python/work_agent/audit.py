from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class AuditLog:
    """Append-only JSONL audit trail. Never mutates or deletes prior entries."""

    def __init__(self, path: Path):
        self.path = path

    def log(self, event: str, details: dict[str, Any] | None = None) -> dict:
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "event": event,
            "details": details or {},
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, sort_keys=True) + "\n")
        return entry

    def read_all(self) -> list[dict]:
        if not self.path.exists():
            return []
        entries = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                entries.append(json.loads(line))
        return entries
