#!/bin/bash
# dispatch-core-sudoers-extend.sh
#
# Idempotent helper that appends the `systemctl reset-failed dispatch-core.service`
# NOPASSWD entry to /etc/sudoers.d/dispatch-ops on the live Kali host.
#
# Why this exists:
#   The committed bootstrap-secure.sh declares the reset-failed entry, but live
#   hosts that ran an older bootstrap (pre-Task 2.1 B5) are missing it. Re-running
#   the full bootstrap is heavy; this surgical extender adds only the missing line.
#
# Usage (run as root on the Kali host):
#   sudo bash /tmp/dispatch-core-sudoers-extend.sh
#
# Idempotent: safe to run repeatedly. If the entry already exists, exits 0 silently.
set -euo pipefail

SUDOERS_FILE="/etc/sudoers.d/dispatch-ops"
ENTRY="adb ALL=(root) NOPASSWD: /bin/systemctl reset-failed dispatch-core.service"
MARKER="reset-failed dispatch-core.service"
TMPFILE="/etc/sudoers.d/.dispatch-ops.tmp.$$"

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: must run as root (try: sudo bash $0)" >&2
  exit 1
fi

if [[ ! -f "${SUDOERS_FILE}" ]]; then
  echo "ERROR: ${SUDOERS_FILE} not found — run infra/bootstrap-secure.sh first" >&2
  exit 1
fi

cleanup() {
  rm -f "${TMPFILE}"
}
trap cleanup EXIT

if grep -q "${MARKER}" "${SUDOERS_FILE}"; then
  echo "already applied — ${SUDOERS_FILE} already contains the reset-failed entry"
  exit 0
fi

# Build the new file in a tempfile under /etc/sudoers.d/ (same FS, atomic rename).
cp -p "${SUDOERS_FILE}" "${TMPFILE}"
printf '%s\n' "${ENTRY}" >> "${TMPFILE}"
chmod 0440 "${TMPFILE}"

# Validate before swapping in.
if ! visudo -cf "${TMPFILE}" >/dev/null; then
  echo "ERROR: visudo validation failed — refusing to install" >&2
  exit 1
fi

install -m 0440 "${TMPFILE}" "${SUDOERS_FILE}"
echo "applied — appended reset-failed entry to ${SUDOERS_FILE}"
echo
echo "Final dispatch-core entries:"
grep dispatch-core "${SUDOERS_FILE}"
