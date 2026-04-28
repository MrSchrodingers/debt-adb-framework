#!/usr/bin/env bash
# runner.sh — Launch frida against WhatsApp and capture JSONL event stream
#
# Usage:
#   ./research/frida/runner.sh [DEVICE_SERIAL] [OUTPUT_FILE]
#
# Defaults:
#   DEVICE_SERIAL  — 9b01005930533036340030832250ac  (POCO C71 test device)
#   OUTPUT_FILE    — /tmp/whatsapp-hook.jsonl
#
# Prerequisites:
#   - frida CLI on PATH:  pip install frida-tools
#   - frida-server running on device: ./research/frida/setup-device.sh
#   - ADB connected

set -euo pipefail

DEVICE_SERIAL="${1:-9b01005930533036340030832250ac}"
OUT="${2:-/tmp/whatsapp-hook.jsonl}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[runner] device:  $DEVICE_SERIAL"
echo "[runner] output:  $OUT"
echo "[runner] script:  $SCRIPT_DIR/hook-whatsapp.js"
echo "[runner] Press Ctrl+C to stop."
echo ""

# Spawn WhatsApp in fresh state, attach hooks from the start, and pipe all
# send() output (JSONL) to the output file. --no-pause lets WA continue
# running immediately without waiting for a resume() call.
frida \
  -U \
  -D "$DEVICE_SERIAL" \
  -f com.whatsapp \
  -l "$SCRIPT_DIR/hook-whatsapp.js" \
  --parameters "{\"serial\":\"$DEVICE_SERIAL\"}" \
  --no-pause \
  -o "$OUT"
