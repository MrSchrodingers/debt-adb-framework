---
name: adb-explore
description: >
  This skill should be used when the user asks to "explore a phone", "inspect device",
  "check smartphone info", "what's on my phone", "device details", "scan android device",
  "adb info", "phone specs", "list apps", "check storage", "check RAM", "phone hardware",
  or wants deep reconnaissance of a connected Android device via ADB.
---

# ADB Device Explorer

Deep-dive exploration of Android devices connected via ADB. Produces comprehensive
device profiles covering hardware, software, network, users, storage, and running state.

## Prerequisites

Verify ADB connectivity before any operation:

```bash
adb devices -l
```

If no device appears, instruct the user to:
1. Enable Developer Options (tap Build Number 7 times in Settings > About)
2. Enable USB Debugging in Developer Options
3. Connect via USB and authorize the computer on the phone prompt

## Exploration Workflow

### Phase 1: Device Identity

Collect core identity properties:

```bash
adb shell getprop ro.product.brand
adb shell getprop ro.product.model
adb shell getprop ro.product.device
adb shell getprop ro.build.version.release    # Android version
adb shell getprop ro.build.version.sdk         # SDK level
adb shell getprop ro.build.display.id          # Build ID
adb shell getprop ro.build.version.security_patch
adb shell getprop ro.serialno
adb shell getprop ro.build.fingerprint
```

### Phase 2: Hardware Profile

```bash
# CPU
adb shell cat /proc/cpuinfo | head -30
adb shell getprop ro.board.platform            # Chipset
adb shell getprop ro.product.cpu.abi           # Architecture

# RAM
adb shell cat /proc/meminfo | head -10

# Screen
adb shell wm size
adb shell wm density

# Storage
adb shell df -h /data /storage/emulated
adb shell dumpsys diskstats | head -15
```

### Phase 3: Software Inventory

```bash
# All packages
adb shell pm list packages | wc -l
adb shell pm list packages -3   # Third-party (user-installed)
adb shell pm list packages -s   # System
adb shell pm list packages -d   # Disabled

# User profiles
adb shell pm list users
```

### Phase 4: Runtime State

```bash
# Running processes
adb shell "dumpsys activity processes" | grep -E "^\s+\*.*:.*/"

# Active notifications
adb shell "dumpsys notification --noredact" | grep -oP 'pkg=\K[^ ]+' | sort | uniq -c | sort -rn

# Battery
adb shell dumpsys battery

# Network
adb shell dumpsys wifi | grep -oP 'SSID: "\K[^"]+'
adb shell ip addr show wlan0 | grep "inet "
```

### Phase 5: Screenshot

Capture the current screen state:

```bash
adb shell screencap -p /sdcard/explore.png
adb pull /sdcard/explore.png /tmp/explore.png
adb shell rm /sdcard/explore.png
```

Use the Read tool on the pulled PNG to visually inspect the screen.

## Output Format

Present results as a structured table with sections: Device, Hardware, Storage, Battery,
Network, Users, and Software. Flag anomalies (low RAM, excessive background processes,
unusual user profiles, outdated security patches).

## Scripts

The exploration script at `/var/www/adb_tools/scripts/explore_device.sh` automates the
full workflow. Run it with:

```bash
/var/www/adb_tools/scripts/explore_device.sh --full     # Everything
/var/www/adb_tools/scripts/explore_device.sh --quick    # Just basics
/var/www/adb_tools/scripts/explore_device.sh --section network  # One section
```

Reports are saved to `/var/www/adb_tools/reports/`.

## Additional Resources

- **`references/properties.md`** - Common Android system properties and their meanings
- **`scripts/explore_device.sh`** - Symlink to /var/www/adb_tools/scripts/explore_device.sh
