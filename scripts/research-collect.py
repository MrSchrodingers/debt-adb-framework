#!/usr/bin/env python3
"""
research-collect.py — Attach Frida to WhatsApp on <serial>, run hook-baseline.js,
write each send() payload as a JSONL line. Auto-reattach on WA crash / detach.
Stops at wall-clock duration.

Usage:
  research-collect.py <serial> <duration-hours> <tag>

Output:
  /tmp/research-<tag>-<safe-serial>.jsonl
"""

import json
import os
import re
import sys
import time
from pathlib import Path

import frida


def safe(serial: str) -> str:
    return re.sub(r"[:./]", "_", serial)


def find_wa_pid(device) -> int | None:
    for proc in device.enumerate_processes():
        if "whatsapp" in proc.name.lower():
            return proc.pid
    return None


def run(serial: str, hours: float, tag: str) -> int:
    repo = Path(os.environ.get("REPO_ROOT", "/var/www/debt-adb-framework"))
    hook_path = repo / "research" / "frida" / "hook-baseline.js"
    if not hook_path.exists():
        print(f"[collect] FATAL: hook not found at {hook_path}", file=sys.stderr)
        return 2

    out_path = Path(f"/tmp/research-{tag}-{safe(serial)}.jsonl")
    end_ts = time.time() + hours * 3600

    print(f"[collect] serial={serial} duration={hours}h tag={tag}")
    print(f"[collect] hook={hook_path}")
    print(f"[collect] out={out_path}")
    out_path.write_text("")

    device = frida.get_device(serial, timeout=10)
    hook_source = hook_path.read_text()

    def now_ms() -> int:
        return int(time.time() * 1000)

    def emit_meta(kind: str, **extra):
        with out_path.open("a") as f:
            f.write(json.dumps({"kind": kind, "ts": now_ms(), "serial": serial, **extra}) + "\n")

    while time.time() < end_ts:
        pid = find_wa_pid(device)
        if not pid:
            emit_meta("collector_wa_missing")
            time.sleep(30)
            continue

        emit_meta("collector_attach", pid=pid)
        try:
            session = device.attach(pid)
        except frida.ProcessNotFoundError:
            emit_meta("collector_attach_failed", error="process_not_found")
            time.sleep(5)
            continue
        except Exception as e:
            emit_meta("collector_attach_failed", error=str(e))
            time.sleep(10)
            continue

        script = session.create_script(hook_source, runtime="v8")

        def on_message(msg, _data):
            if msg.get("type") == "send":
                payload = msg.get("payload") or {}
                if "serial" not in payload or payload.get("serial") == "unknown":
                    payload["serial"] = serial
                payload.setdefault("ts", now_ms())
                with out_path.open("a") as f:
                    f.write(json.dumps(payload) + "\n")
            elif msg.get("type") == "error":
                emit_meta("collector_script_error", error=msg.get("description", str(msg)))

        script.on("message", on_message)

        try:
            script.load()
        except Exception as e:
            emit_meta("collector_load_failed", error=str(e))
            try:
                session.detach()
            except Exception:
                pass
            time.sleep(10)
            continue

        # Hold the attach until wall-clock end OR session detaches.
        detached = {"flag": False}

        def on_detached(reason, *_):
            detached["flag"] = True
            emit_meta("collector_session_detached", reason=str(reason))

        session.on("detached", on_detached)

        # Poll loop until detach or duration end.
        while time.time() < end_ts and not detached["flag"]:
            time.sleep(2)

        try:
            script.unload()
        except Exception:
            pass
        try:
            session.detach()
        except Exception:
            pass

        emit_meta("collector_detach")
        if time.time() < end_ts:
            time.sleep(5)  # brief pause before re-attach if WA respawned

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
