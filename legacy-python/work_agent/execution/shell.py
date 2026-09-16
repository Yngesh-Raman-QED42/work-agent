from __future__ import annotations

import subprocess
from dataclasses import dataclass


@dataclass
class CommandResult:
    command: str
    returncode: int
    output: str  # combined stdout+stderr

    @property
    def ok(self) -> bool:
        return self.returncode == 0


def run(cmd: list[str], cwd: str | None = None, timeout: int = 600, env: dict | None = None) -> CommandResult:
    try:
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            timeout=timeout,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        return CommandResult(command=" ".join(cmd), returncode=proc.returncode, output=proc.stdout)
    except subprocess.TimeoutExpired as exc:
        output = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
        return CommandResult(command=" ".join(cmd), returncode=124, output=output + f"\n[timed out after {timeout}s]")


def run_or_raise(cmd: list[str], cwd: str | None = None, timeout: int = 600) -> CommandResult:
    result = run(cmd, cwd=cwd, timeout=timeout)
    if not result.ok:
        raise RuntimeError(f"command failed ({result.command}):\n{result.output[-2000:]}")
    return result
