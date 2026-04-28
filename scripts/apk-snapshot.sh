#!/usr/bin/env bash
set -euo pipefail

DEVICE_SERIAL="${1:-${DEVICE_SERIAL:-}}"
OUT_DIR="${APK_BACKUP_DIR:-/var/backups/whatsapp-apks}"
PKG="${PACKAGE:-com.whatsapp}"

if [ -z "$DEVICE_SERIAL" ]; then
  DEVICE_SERIAL="$(adb devices | awk 'NR==2 {print $1}')"
  if [ -z "$DEVICE_SERIAL" ]; then
    echo "ERROR: No device serial provided and no device detected via 'adb devices'." >&2
    echo "Usage: $0 <device-serial>" >&2
    echo "Or set DEVICE_SERIAL env var." >&2
    exit 1
  fi
  echo "No serial provided — using first detected device: $DEVICE_SERIAL"
fi

PATH_ON_DEVICE="$(adb -s "$DEVICE_SERIAL" shell pm path "$PKG" 2>/dev/null | head -1 | sed 's/^package://' | tr -d '\r')"
if [ -z "$PATH_ON_DEVICE" ]; then
  echo "ERROR: Package '$PKG' not found on device '$DEVICE_SERIAL'." >&2
  exit 1
fi

VERSION="$(adb -s "$DEVICE_SERIAL" shell dumpsys package "$PKG" 2>/dev/null \
  | awk '/versionName=/ {print $1}' | head -1 | cut -d= -f2 | tr -d '\r')"
if [ -z "$VERSION" ]; then
  echo "ERROR: Could not determine version for '$PKG' on device '$DEVICE_SERIAL'." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
DEST="$OUT_DIR/${PKG}-${VERSION}.apk"

if [ -f "$DEST" ]; then
  echo "APK already snapshotted: $DEST"
  exit 0
fi

echo "Pulling $PKG v$VERSION from $DEVICE_SERIAL..."
adb -s "$DEVICE_SERIAL" pull "$PATH_ON_DEVICE" "$DEST"

META="$OUT_DIR/apk_versions.json"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SIZE="$(stat -c%s "$DEST")"
SHA256="$(sha256sum "$DEST" | awk '{print $1}')"

if [ -f "$META" ]; then
  jq --arg v "$VERSION" --arg t "$TIMESTAMP" --arg s "$SIZE" --arg h "$SHA256" --arg p "$DEST" \
    '. += [{"version": $v, "timestamp": $t, "size_bytes": ($s | tonumber), "sha256": $h, "path": $p}]' \
    "$META" > "$META.tmp" && mv "$META.tmp" "$META"
else
  jq -n --arg v "$VERSION" --arg t "$TIMESTAMP" --arg s "$SIZE" --arg h "$SHA256" --arg p "$DEST" \
    '[{"version": $v, "timestamp": $t, "size_bytes": ($s | tonumber), "sha256": $h, "path": $p}]' \
    > "$META"
fi

echo "Snapshot saved to $DEST"
echo "Metadata updated in $META"
