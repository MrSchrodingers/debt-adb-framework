#!/usr/bin/env python3
"""
research-collect.py — KNOWN-BROKEN. Kept as artifact of 2026-04-28 research
attempts. DO NOT RUN against the production POCO without first solving the
underlying Frida-vs-anti-tamper problem (see issues below).

Original goal: drive the `frida` CLI as a subprocess, parse its REPL output,
write JSONL of every send() payload for ban-prediction calibration.

Why it does not work in this setup:

  1. Frida 17.x Python bindings — `session.create_script()` does NOT auto-inject
     the `Java` global bridge → scripts crash with
     `ReferenceError: 'Java' is not defined`. CLI still injects Java.
  2. Frida CLI subprocess — exits the REPL when stdin EOFs (DEVNULL) and even
     with PIPE keeps the script ~5s before unloading. Pseudo-TTY via `script -qec`
     and Python `pty` produce zero emitted messages.
  3. `frida-trace` 90s sandbox: stable, no ANR, but ZERO method invocations on
     the 5 classes when WhatsApp is idle (anti-tamper classes are reactive to
     send/sync paths only).
  4. `frida-trace` 5min idle: WhatsApp `Process terminated` after ~3min.
     Anti-tamper detected Frida and killed the process.
  5. Frida 16.6.6 downgrade attempt: starting frida-server-16.x on the device
     triggered a full Android reboot (likely a Magisk module fingerprint check
     on the new binary signature).

Decision (2026-04-28): stop Frida path on this device. Next session must:
  - Study Zygisk-Frida module compatibility with the installed Magisk + PIF +
    Zygisk-Assistant stack BEFORE pushing anything to the device.
  - Validate stealth via offline test (a redroid container or a 2nd POCO),
    NOT against the production POCO.
  - Reconsider whether the calibration goal can be achieved via a sidechannel
    (logcat exception rate, ban-detection OCR, queue retry rate as proxy)
    rather than direct method-call counting.

Discovered anti-tamper classes (8s frida runtime enumeration before tooling
broke — these names are valid and valuable for next session):
  - com.whatsapp.kmp.syncd.syncdengine.crypto.KmpSyncdAntiTamperingLoggingHelper
  - com.whatsapp.kmp.syncd.syncdengine.crypto.KmpSyncdIncomingAntiTamperingValidator
  - com.whatsapp.bizintegritysignals.BizIntegritySignalsManager
  - com.whatsapp.bizintegritysignals.BizIntegritySignalsGraphQLFetcher
  - com.whatsapp.integritysignals.waiutils.F38E2C86AEEBBEDDC0324  (obfuscated)
  - com.whatsapp.infra.security.sandbox.OxidizedCurve25519
  - com.whatsapp.infra.crash.anr.SigquitBasedANRDetector
  - com.whatsapp.dobverification.common.CommonRemediationApi
  - com.whatsapp.dobverification.ContextualAgeCollectionRepository
  - com.whatsapp.bizintegrity.logger.receiver.scheduler.ReceiverLoggingWorker
  - com.whatsapp.bizintegrity.logger.receiver.handler.ReceiverLoggingManager$createReceiverData$threadsAndMessageCounts$1
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

def parse_frida_line(line: str) -> str | None:
    """Extract the message body (Python-repr dict) from a frida CLI output line.
    Returns None if the line is not a structured `message:` line.

    Example input:
      message: {'type': 'send', 'payload': {'kind': 'class_loaded'}} data: None
    """
    line = line.strip()
    if not line.startswith("message:"):
        return None
    rest = line[len("message:"):].strip()
    if " data:" not in rest:
        return None
    body, _ = rest.rsplit(" data:", 1)
    return body.strip()


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

        # frida CLI exits the REPL (and unloads the script) when stdin EOFs.
        # Keep stdin open as an empty PIPE so the script keeps running.
        proc = subprocess.Popen(
            [frida_bin, "-U", "-p", str(pid), "-l", str(hook_path)],
            stdin=subprocess.PIPE,
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
                body = parse_frida_line(line)
                if body is None:
                    continue
                try:
                    parsed = json.loads(repr_to_json(body))
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
