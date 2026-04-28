#!/usr/bin/env bash
set -euo pipefail

# apk-snapshot.sh — pull every APK split for a package and snapshot under
# OUT_DIR/<pkg>-<version>/{base,arm64,xhdpi,...}.apk. Native libraries (likely
# anti-cheat code) live in split_config.arm64_v8a.apk, so the previous version
# that pulled only base.apk missed the most ban-research-relevant payload.
#
# Usage:
#   apk-snapshot.sh [DEVICE_SERIAL]
#   PACKAGE=com.whatsapp APK_BACKUP_DIR=/var/.../apks  apk-snapshot.sh

DEVICE_SERIAL="${1:-${DEVICE_SERIAL:-}}"
OUT_DIR="${APK_BACKUP_DIR:-/var/backups/whatsapp-apks}"
PKG="${PACKAGE:-com.whatsapp}"

if [ -z "$DEVICE_SERIAL" ]; then
  DEVICE_SERIAL="$(adb devices | awk 'NR==2 {print $1}')"
  if [ -z "$DEVICE_SERIAL" ]; then
    echo "ERROR: No device serial provided and no device detected via 'adb devices'." >&2
    echo "Usage: $0 <device-serial>" >&2
    exit 1
  fi
  echo "No serial provided — using first detected device: $DEVICE_SERIAL"
fi

# All paths for the package — base + every split.
mapfile -t DEVICE_PATHS < <(adb -s "$DEVICE_SERIAL" shell pm path "$PKG" 2>/dev/null \
  | sed 's/^package://' | tr -d '\r')

if [ "${#DEVICE_PATHS[@]}" -eq 0 ]; then
  echo "ERROR: Package '$PKG' not found on device '$DEVICE_SERIAL'." >&2
  exit 1
fi

VERSION="$(adb -s "$DEVICE_SERIAL" shell dumpsys package "$PKG" 2>/dev/null \
  | awk '/versionName=/ {print $1}' | head -1 | cut -d= -f2 | tr -d '\r')"
if [ -z "$VERSION" ]; then
  echo "ERROR: Could not determine version for '$PKG' on device '$DEVICE_SERIAL'." >&2
  exit 1
fi

VER_DIR="$OUT_DIR/${PKG}-${VERSION}"
if [ -d "$VER_DIR" ] && [ -n "$(ls -A "$VER_DIR" 2>/dev/null)" ]; then
  echo "APK version already snapshotted at $VER_DIR — skipping."
  exit 0
fi
mkdir -p "$VER_DIR"

# Map split path → friendly local name.
local_name_for_split() {
  local p="$1"
  local b
  b="$(basename "$p" .apk)"
  case "$b" in
    base)                      echo "base.apk" ;;
    split_config.arm64_v8a)    echo "arm64_v8a.apk" ;;
    split_config.armeabi_v7a)  echo "armeabi_v7a.apk" ;;
    split_config.x86_64)       echo "x86_64.apk" ;;
    split_config.xhdpi)        echo "xhdpi.apk" ;;
    split_config.xxhdpi)       echo "xxhdpi.apk" ;;
    split_config.xxxhdpi)      echo "xxxhdpi.apk" ;;
    split_*)                   echo "${b#split_}.apk" ;;
    *)                         echo "${b}.apk" ;;
  esac
}

echo "Pulling $PKG v$VERSION (${#DEVICE_PATHS[@]} parts) from $DEVICE_SERIAL..."

declare -a META_PARTS=()
for p in "${DEVICE_PATHS[@]}"; do
  local_name="$(local_name_for_split "$p")"
  dest="$VER_DIR/$local_name"
  echo "  -> $local_name"
  adb -s "$DEVICE_SERIAL" pull "$p" "$dest" >/dev/null
  size="$(stat -c%s "$dest")"
  sha="$(sha256sum "$dest" | awk '{print $1}')"
  META_PARTS+=("$(jq -n --arg n "$local_name" --arg p "$dest" --arg s "$size" --arg h "$sha" \
    '{name: $n, path: $p, size_bytes: ($s | tonumber), sha256: $h}')")
done

META="$OUT_DIR/apk_versions.json"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Build a single record of this version.
PARTS_JSON="$(printf '%s\n' "${META_PARTS[@]}" | jq -s .)"
RECORD="$(jq -n \
  --arg v "$VERSION" \
  --arg t "$TIMESTAMP" \
  --arg p "$PKG" \
  --arg d "$DEVICE_SERIAL" \
  --argjson parts "$PARTS_JSON" \
  '{package: $p, version: $v, timestamp: $t, source_device: $d, parts: $parts}')"

if [ -f "$META" ]; then
  jq --argjson r "$RECORD" '. += [$r]' "$META" > "$META.tmp" && mv "$META.tmp" "$META"
else
  jq -n --argjson r "$RECORD" '[$r]' > "$META"
fi

echo "Snapshot saved to $VER_DIR"
echo "Metadata updated in $META"
