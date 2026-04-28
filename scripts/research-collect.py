#!/usr/bin/env python3
"""
research-collect.py — Drive the `frida` CLI as a subprocess, parse its REPL
output (`message: {...}` lines, Python-repr style), and write a clean JSONL
of every send() payload.

Why subprocess instead of `frida` Python bindings:
  Frida 17.x's Python `session.create_script()` does NOT auto-inject the
  `Java` global bridge — scripts get `ReferenceError: 'Java' is not defined`.
  The `frida` CLI binary still injects Java automatically. Wrapping the CLI
  is the simplest, most reliable path until the binding API stabilizes.

Usage:
  research-collect.py <serial> <duration-hours> <tag>

Output:
  /tmp/research-<tag>-<safe-serial>.jsonl
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

MESSAGE_RE = re.compile(r"^message:\s*(\{.*?\})\s*data:\s*(\S.*)?$")


def safe(serial: str) -> str:
    return re.sub(r"[:./]", "_", serial)


def find_wa_pid(serial: str, frida_ps: str) -> int | None:
    try:
        out = subprocess.check_output(
            [frida_ps, "-D", serial], text=True, timeout=10
        )
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
        return None
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].isdigit() and "whatsapp" in parts[1].lower():
            return int(parts[0])
    return None


def repr_to_json(body: str) -> str:
    """Convert a Python-repr dict to JSON. Hook payloads only use str/int/
    bool/None/dict/list with no embedded quotes, so naive substitution is safe."""
    return (
        body.replace("'", '"')
        .replace(": None", ": null")
        .replace(": True", ": true")
        .replace(": False", ": false")
    )


def run(serial: str, hours: float, tag: str) -> int:
    repo = Path(os.environ.get("REPO_ROOT", "/var/www/debt-adb-framework"))
    hook_path = repo / "research" / "frida" / "hook-baseline.js"
    if not hook_path.exists():
        print(f"[collect] FATAL: hook not found at {hook_path}", file=sys.stderr)
        return 2

    home = Path.home()
    frida_bin = os.environ.get("FRIDA", str(home / ".venv-frida/bin/frida"))
    frida_ps_bin = os.environ.get("FRIDA_PS", str(home / ".venv-frida/bin/frida-ps"))
    if not shutil.which(frida_bin) and not Path(frida_bin).exists():
        print(f"[collect] FATAL: frida not found at {frida_bin}", file=sys.stderr)
        return 2

    out_path = Path(f"/tmp/research-{tag}-{safe(serial)}.jsonl")
    end_ts = time.time() + hours * 3600

    print(f"[collect] serial={serial} duration={hours}h tag={tag}")
    print(f"[collect] hook={hook_path}")
    print(f"[collect] out={out_path}")
    out_path.write_text("")

    def now_ms() -> int:
        return int(time.time() * 1000)

    def emit_meta(kind: str, **extra) -> None:
        with out_path.open("a") as f:
            f.write(json.dumps({"kind": kind, "ts": now_ms(), "serial": serial, **extra}) + "\n")

    while time.time() < end_ts:
        pid = find_wa_pid(serial, frida_ps_bin)
        if not pid:
            emit_meta("collector_wa_missing")
            time.sleep(30)
            continue

        emit_meta("collector_attach", pid=pid)

        # Cap each frida session at 1h. Outer loop re-attaches if duration > 1h.
        remaining = max(60, int(end_ts - time.time()))
        session_secs = min(remaining, 3600)

        proc = subprocess.Popen(
            [frida_bin, "-U", "-p", str(pid), "-l", str(hook_path)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        deadline = time.time() + session_secs
        try:
            while True:
                if time.time() >= deadline:
                    break
                line = proc.stdout.readline()
                if not line:
                    break  # frida exited
                m = MESSAGE_RE.match(line.strip())
                if not m:
                    continue
                json_body = repr_to_json(m.group(1))
                try:
                    parsed = json.loads(json_body)
                except json.JSONDecodeError:
                    continue
                if parsed.get("type") != "send":
                    continue
                payload = parsed.get("payload") or {}
                if "serial" not in payload or payload.get("serial") == "unknown":
                    payload["serial"] = serial
                payload.setdefault("ts", now_ms())
                with out_path.open("a") as f:
                    f.write(json.dumps(payload) + "\n")
        finally:
            try:
                proc.send_signal(signal.SIGTERM)
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            except Exception:
                pass

        emit_meta("collector_detach")
        if time.time() < end_ts:
            time.sleep(5)

    lines = sum(1 for _ in out_path.open())
    print(f"[collect] done — {lines} events in {out_path}")
    return 0


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: research-collect.py <serial> <duration-hours> <tag>", file=sys.stderr)
        return 2
    serial = sys.argv[1]
    hours = float(sys.argv[2])
    tag = sys.argv[3]
    return run(serial, hours, tag)


if __name__ == "__main__":
    sys.exit(main())
