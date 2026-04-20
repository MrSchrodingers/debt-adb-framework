---
name: adb-bloatware
description: >
  This skill should be used when the user asks to "remove bloatware", "debloat phone",
  "uninstall system apps", "clean up phone apps", "remove pre-installed apps",
  "disable bloatware", "free up phone space", "remove Xiaomi apps", "remove Samsung apps",
  "remove Google apps", "phone has too many apps", or wants to remove unwanted
  pre-installed applications from an Android device via ADB.
---

# ADB Bloatware Removal

Safe removal of pre-installed bloatware from Android devices without root access.
Uses per-user uninstall with data preservation for full reversibility.

## Core Method

```bash
adb shell pm uninstall -k --user <USER_ID> <package>
```

- `-k` preserves app data (reinstallable from Play Store)
- `--user` removes only for that user profile (no root needed)
- Reversible via `adb shell cmd package install-existing --user <USER_ID> <package>`

## Safety Protocol

### NEVER Remove These
Essential packages that will brick/break the device if removed:

- `com.android.systemui` - System UI (status bar, notifications)
- `com.android.settings` - Settings app
- `com.android.phone` - Phone/dialer
- `com.android.providers.contacts` - Contacts database
- `com.android.providers.telephony` - Telephony database
- `com.google.android.gms` - Google Play Services
- `com.android.vending` - Play Store
- `com.google.android.gsf` - Google Services Framework
- `com.google.android.webview` - WebView (breaks all apps using web content)
- `com.google.android.inputmethod.latin` - Gboard (keyboard)
- `com.spreadtrum.ims` / `com.qualcomm.ims` - IMS/VoLTE
- `com.google.android.permissioncontroller` - Permission system
- Any default launcher (check with `adb shell cmd shortcut get-default-launcher`)

### Always Check Before Removing
- The default launcher: `adb shell cmd shortcut get-default-launcher`
- Active user profiles: `adb shell pm list users`
- If package is already disabled: `adb shell pm list packages -d`

## Workflow

### Step 1: Reconnaissance

```bash
# Detect user profiles
adb shell pm list users

# List third-party apps
adb shell pm list packages -3

# List all system apps
adb shell pm list packages -s

# List already disabled
adb shell pm list packages -d
```

### Step 2: Identify Bloatware by Vendor

Consult `references/bloatware-database.md` for known bloatware per vendor
(Xiaomi, Samsung, Google, Carrier, etc.).

### Step 3: Backup Package List

```bash
adb shell pm list packages | sed 's/package://' | sort > /var/www/adb_tools/data/backup_$(date +%Y%m%d).txt
```

### Step 4: Remove Per Category

Execute removals per category (Xiaomi, Facebook, Google, Other), per active user:

```bash
for user in $(adb shell pm list users | grep -oP '\{\K\d+'); do
  adb shell pm uninstall -k --user "$user" "$PACKAGE"
done
```

### Step 5: Validate

```bash
# Check remaining apps
adb shell pm list packages -3

# Screenshot the app drawer
adb shell screencap -p /sdcard/after.png && adb pull /sdcard/after.png /tmp/after.png

# Check for boot issues
adb shell dumpsys activity processes | grep -c "\*"
```

### Step 6: Generate Restore Script

Create a restore script listing all removed packages with
`adb shell cmd package install-existing --user $USER $PACKAGE` for each.

## Scripts

Pre-built scripts at `/var/www/adb_tools/scripts/`:

- **`cleanup_bloatware.sh`** - Interactive/automated bloatware removal
  - `--all` removes everything without prompting
  - `--dry-run` shows what would be removed
  - `--category xiaomi|facebook|google|other` targets one category
  - `--package com.x.y` removes a single package
- **`restore_bloatware.sh`** - Reverses removals
  - `--list` shows all restorable packages
  - `--category google` restores one category
  - `com.x.y` restores a single package

## Additional Resources

- **`references/bloatware-database.md`** - Known bloatware by vendor with risk levels
