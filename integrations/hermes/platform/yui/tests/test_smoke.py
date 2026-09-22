from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path

SMOKE_PATH = Path(__file__).parents[1] / "skills" / "yui-platform-smoke-test" / "smoke.py"
SPEC = importlib.util.spec_from_file_location("yui_platform_smoke", SMOKE_PATH)
assert SPEC is not None and SPEC.loader is not None
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)


def test_smoke_waits_for_startup_restore(tmp_path: Path) -> None:
    log = tmp_path / "agent.log"
    log.write_text("yui: accepting clients on ws://127.0.0.1:8646/ws\n", encoding="utf-8")

    async def check() -> None:
        waiting = asyncio.create_task(SMOKE.wait_for_gateway_ready(log, timeout=1))
        await asyncio.sleep(0.05)
        assert not waiting.done()
        with log.open("a", encoding="utf-8") as stream:
            stream.write("gateway.run: Turn machinery warmed in 4.4s\n")
        await waiting

    asyncio.run(check())


def test_smoke_ignores_a_warm_marker_from_an_earlier_gateway_start(tmp_path: Path) -> None:
    log = tmp_path / "agent.log"
    log.write_text(
        "gateway.run: Turn machinery warmed in 4.4s\nyui: accepting clients on ws://127.0.0.1:8646/ws\n",
        encoding="utf-8",
    )

    async def check() -> None:
        waiting = asyncio.create_task(SMOKE.wait_for_gateway_ready(log, timeout=1))
        await asyncio.sleep(0.05)
        assert not waiting.done()
        with log.open("a", encoding="utf-8") as stream:
            stream.write("gateway.run: Turn machinery warmed in 4.4s\n")
        await waiting

    asyncio.run(check())
