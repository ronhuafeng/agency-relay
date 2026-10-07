from __future__ import annotations

import json
import pathlib


SHIM_DIR = pathlib.Path(__file__).parents[1]
PROTOCOL = json.loads((SHIM_DIR / "egress-protocol.json").read_text())
MANIFEST_HEADER = PROTOCOL["manifestHeader"]
SECRET_HEADER = PROTOCOL["secretHeader"]
TRACE_HEADER = PROTOCOL["transportTrace"]["header"]


def manifest_value(names: list[str]) -> str:
    normalized = sorted({name.lower() for name in names})
    return json.dumps(normalized, separators=(",", ":"))


def protected_headers(
    secret: str,
    intended: dict[str, str],
    transport_added: dict[str, str] | None = None,
) -> dict[str, str]:
    return {
        **intended,
        **(transport_added or {}),
        SECRET_HEADER: secret,
        MANIFEST_HEADER: manifest_value(list(intended)),
    }
