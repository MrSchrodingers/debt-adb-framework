#!/usr/bin/env bash
# setup-device.sh — Push frida-server to device and start it (idempotent)
#
# Usage:
#   ./research/frida/setup-device.sh [DEVICE_SERIAL] [FRIDA_SERVER_BINARY]
#
# Defaults:
#   DEVICE_SERIAL        — 9b01005930533036340030832250ac
#   FRIDA_SERVER_BINARY  — ./frida-server  (must exist in CWD or be full path)
#
# The script is idempotent:
#   - If frida-server is already running on the device it is not started again.
#   - If the binary already exists at /data/local/tmp/frida-server with the
#     correct size it is not re-pushed.

set -euo pipefail

DEVICE_SERIAL="${1:-9b01005930533036340030832250ac}"
FRIDA_BIN="${2:-./frida-server}"
DEVICE_PATH="/data/local/tmp/frida-server"

# ── Validation ─────────────────────────────────────────────────────────────

if ! command -v adb &>/dev/null; then
  echo "[setup] ERROR: adb not found on PATH" >&2
  exit 1
fi

if ! command -v frida-ps &>/dev/null; then
  echo "[setup] ERROR: frida-ps not found. Install with: pip install frida-tools" >&2
  exit 1
fi

if [[ ! -f "$FRIDA_BIN" ]]; then
  echo "[setup] ERROR: frida-server binary not found at: $FRIDA_BIN" >&2
  echo ""
  echo "  Download from https://github.com/frida/frida/releases"
  echo "  Pick: frida-server-<version>-android-arm64.xz"
  echo "  Then: xz -d frida-server-*.xz && mv frida-server-*-android-arm64 frida-server"
  exit 1
fi

echo "[setup] Target device: $DEVICE_SERIAL"

# ── Check if frida-server is already running ───────────────────────────────

ALREADY_RUNNING=0
if adb -s "$DEVICE_SERIAL" shell "pgrep -f frida-server" &>/dev/null 2>&1; then
  ALREADY_RUNNING=1
  echo "[setup] frida-server already running on device — skipping start"
fi

# ── Push binary (only if sizes differ or not present) ─────────────────────

if [[ "$ALREADY_RUNNING" -eq 0 ]]; then
  LOCAL_SIZE=$(wc -c < "$FRIDA_BIN")
  REMOTE_SIZE=$(adb -s "$DEVICE_SERIAL" shell "stat -c %s $DEVICE_PATH 2>/dev/null || echo 0" | tr -d '[:space:]')

  if [[ "$LOCAL_SIZE" != "$REMOTE_SIZE" ]]; then
    echo "[setup] Pushing frida-server to $DEVICE_PATH ..."
    adb -s "$DEVICE_SERIAL" push "$FRIDA_BIN" "$DEVICE_PATH"
    echo "[setup] Push complete"
  else
    echo "[setup] Binary already present with matching size, skip push"
  fi

  # Ensure executable bit
  adb -s "$DEVICE_SERIAL" shell "chmod 755 $DEVICE_PATH"
  echo "[setup] chmod 755 applied"

  # ── Start frida-server as root in background ─────────────────────────────

  echo "[setup] Starting frida-server ..."
  adb -s "$DEVICE_SERIAL" shell "su -c '$DEVICE_PATH &' &"

  # Give it a moment to bind
  sleep 2
fi

# ── Verify via frida-ps ────────────────────────────────────────────────────

echo "[setup] Verifying with frida-ps -U -D $DEVICE_SERIAL ..."
if frida-ps -U -D "$DEVICE_SERIAL" &>/dev/null; then
  echo "[setup] SUCCESS: frida-server is reachable"
else
  echo "[setup] ERROR: frida-ps could not reach frida-server" >&2
  echo "  Check: adb -s $DEVICE_SERIAL logcat | grep frida" >&2
  exit 1
fi

echo "[setup] Device ready. Run: ./research/frida/runner.sh $DEVICE_SERIAL"
