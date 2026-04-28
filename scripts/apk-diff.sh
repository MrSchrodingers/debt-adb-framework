#!/usr/bin/env bash
set -euo pipefail

V1="${1:-}"
V2="${2:-}"

if [ -z "$V1" ] || [ -z "$V2" ]; then
  echo "Usage: $0 <apk-v1-path> <apk-v2-path>" >&2
  echo "Output: ./reports/apk-diff-<v1>-vs-<v2>.md" >&2
  exit 1
fi

if [ ! -f "$V1" ]; then
  echo "ERROR: File not found: $V1" >&2
  exit 1
fi

if [ ! -f "$V2" ]; then
  echo "ERROR: File not found: $V2" >&2
  exit 1
fi

# Resolve apktool: prefer the user's modern wrapper at ~/.local/bin/apktool-modern,
# then any apktool-modern on PATH, then the system apktool. Distro packages
# (Kali apktool 2.7.0) cannot decode WhatsApp 2.26+; the user wrapper points
# at the upstream JAR (2.10+) and works on all current targets.
APKTOOL_BIN=""
if [ -x "$HOME/.local/bin/apktool-modern" ]; then
  APKTOOL_BIN="$HOME/.local/bin/apktool-modern"
elif command -v apktool-modern &>/dev/null; then
  APKTOOL_BIN="$(command -v apktool-modern)"
elif command -v apktool &>/dev/null; then
  APKTOOL_BIN="$(command -v apktool)"
  echo "WARN: using distro apktool ($APKTOOL_BIN). For modern WhatsApp APKs install apktool-modern (see research/apk/README.md)." >&2
else
  echo "ERROR: apktool not found. See research/apk/README.md for install instructions." >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq not found. Install with: sudo apt install jq" >&2
  exit 1
fi

V1_NAME="$(basename "$V1" .apk)"
V2_NAME="$(basename "$V2" .apk)"
WORK_DIR="$(mktemp -d)"
REPORT_DIR="${REPORT_DIR:-reports}"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "Decoding $V1_NAME..."
"$APKTOOL_BIN" d -f -o "$WORK_DIR/v1" "$V1" >/dev/null
echo "Decoding $V2_NAME..."
"$APKTOOL_BIN" d -f -o "$WORK_DIR/v2" "$V2" >/dev/null

mkdir -p "$REPORT_DIR"
REPORT="$REPORT_DIR/apk-diff-${V1_NAME}-vs-${V2_NAME}.md"

APKTOOL_VER="$("$APKTOOL_BIN" --version 2>&1 | head -1)"
FILES_DIFF="$(diff -rq "$WORK_DIR/v1" "$WORK_DIR/v2" 2>/dev/null | head -80 || true)"
MANIFEST_DIFF="$(diff "$WORK_DIR/v1/AndroidManifest.xml" "$WORK_DIR/v2/AndroidManifest.xml" 2>/dev/null | head -120 || true)"
SMALI_SUMMARY="$(grep -E "smali_classes" "$WORK_DIR/v2/apktool.yml" 2>/dev/null || echo "N/A")"
NEW_SECURITY="$(diff -rq "$WORK_DIR/v1" "$WORK_DIR/v2" 2>/dev/null \
  | grep -E "com/whatsapp/security" | head -40 || echo "none")"
NEW_STRINGS="$(diff "$WORK_DIR/v1/res/values/strings.xml" "$WORK_DIR/v2/res/values/strings.xml" 2>/dev/null \
  | grep -Ei "ban|block|suspend|restrict|violation|policy" | head -40 || echo "none")"

cat > "$REPORT" <<EOF
# APK Diff: ${V1_NAME} vs ${V2_NAME}

Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Tool: apktool ${APKTOOL_VER}

## Files added/removed

\`\`\`
${FILES_DIFF}
\`\`\`

## AndroidManifest.xml diff

\`\`\`diff
${MANIFEST_DIFF}
\`\`\`

## Package summary (v2)

\`\`\`
${SMALI_SUMMARY}
\`\`\`

## Security-related smali changes

\`\`\`
${NEW_SECURITY}
\`\`\`

## Ban/policy-related string changes

\`\`\`
${NEW_STRINGS}
\`\`\`
EOF

echo "Report written to $REPORT"
