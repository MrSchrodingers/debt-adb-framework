---
name: adb-automation
description: >
  This skill should be used when the user asks to "automate phone tasks", "adb automation",
  "schedule phone actions", "auto tap", "ui automation android", "simulate touches",
  "automate app actions", "create phone macro", "adb input commands", "screen automation",
  "batch adb commands", "phone bot", "auto-click", or wants to automate interactions
  on an Android device via ADB input commands and intents.
---

# ADB Automation

Automate Android device interactions via ADB input commands, intents, and shell scripts.
Build macros, scheduled tasks, and UI automation workflows without root.

## Input Commands Reference

### Touch & Gestures

```bash
# Tap at coordinates
adb shell input tap <x> <y>

# Long press (swipe with zero distance, duration in ms)
adb shell input swipe <x> <y> <x> <y> 2000

# Swipe
adb shell input swipe <x1> <y1> <x2> <y2> [duration_ms]

# Pinch (requires two fingers - use touchscreen protocol)
# Not directly supported by input command

# Drag (swipe with longer duration)
adb shell input swipe <x1> <y1> <x2> <y2> 500
```

### Text Input

```bash
# Type text (no spaces - use %s for space)
adb shell input text "hello%sworld"

# For special characters, use keyevents
adb shell input keyevent KEYCODE_AT          # @
adb shell input keyevent KEYCODE_PERIOD      # .
```

### Key Events

```bash
# Navigation
adb shell input keyevent KEYCODE_HOME           # Home button
adb shell input keyevent KEYCODE_BACK           # Back button
adb shell input keyevent KEYCODE_APP_SWITCH     # Recent apps
adb shell input keyevent KEYCODE_MENU           # Menu

# Power
adb shell input keyevent KEYCODE_WAKEUP         # Wake screen
adb shell input keyevent KEYCODE_SLEEP          # Lock screen
adb shell input keyevent KEYCODE_POWER          # Toggle power

# Volume
adb shell input keyevent KEYCODE_VOLUME_UP
adb shell input keyevent KEYCODE_VOLUME_DOWN
adb shell input keyevent KEYCODE_VOLUME_MUTE

# Media
adb shell input keyevent KEYCODE_MEDIA_PLAY_PAUSE
adb shell input keyevent KEYCODE_MEDIA_NEXT
adb shell input keyevent KEYCODE_MEDIA_PREVIOUS

# Text editing
adb shell input keyevent KEYCODE_DEL            # Backspace
adb shell input keyevent KEYCODE_ENTER          # Enter
adb shell input keyevent KEYCODE_TAB            # Tab
adb shell input keyevent KEYCODE_ESCAPE         # Escape
adb shell input keyevent --longpress KEYCODE_A  # Long press A (select all)
```

### Screen State

```bash
# Check if screen is on
adb shell dumpsys power | grep "mWakefulness"
# mWakefulness=Awake | Asleep | Dreaming

# Screen on/off
adb shell input keyevent KEYCODE_WAKEUP
adb shell input keyevent KEYCODE_SLEEP
```

## Intent System

### Launch Apps

```bash
# Launch by package (auto-finds main activity)
adb shell monkey -p <package> -c android.intent.category.LAUNCHER 1

# Launch specific activity
adb shell am start -n <package>/<activity>

# Launch with data URI
adb shell am start -a android.intent.action.VIEW -d "https://example.com"

# Launch with extras
adb shell am start -n <package>/<activity> --es key "string_value" --ei key 42
```

### Broadcast Events

```bash
# Send a broadcast
adb shell am broadcast -a <action>

# Simulate airplane mode toggle
adb shell settings put global airplane_mode_on 1
adb shell am broadcast -a android.intent.action.AIRPLANE_MODE

# Screen off broadcast
adb shell am broadcast -a android.intent.action.SCREEN_OFF
```

### Service Management

```bash
# Start a service
adb shell am startservice -n <package>/<service>

# Stop a service
adb shell am stopservice -n <package>/<service>

# Force stop an app
adb shell am force-stop <package>
```

## Building Automation Scripts

### Template: Sequential Actions

```bash
#!/bin/bash
# automation_template.sh - Sequential UI automation

DELAY=1  # seconds between actions

wait_and_tap() {
  sleep "$DELAY"
  adb shell input tap "$1" "$2"
  echo "Tapped ($1, $2)"
}

wait_and_type() {
  sleep "$DELAY"
  adb shell input text "$1"
  echo "Typed: $1"
}

screenshot() {
  local name="${1:-step}"
  adb shell screencap -p "/sdcard/${name}.png"
  adb pull "/sdcard/${name}.png" "/tmp/${name}.png" 2>/dev/null
  adb shell rm "/sdcard/${name}.png"
  echo "Screenshot: /tmp/${name}.png"
}

# Wake and unlock
adb shell input keyevent KEYCODE_WAKEUP
sleep 1
adb shell input swipe 360 1400 360 600  # swipe up to unlock

# Open app
adb shell am start -n com.whatsapp/com.whatsapp.Main
sleep 2
screenshot "step1_app_opened"

# Interact
wait_and_tap 360 300    # tap first chat
wait_and_tap 360 1550   # tap message field
wait_and_type "Hello"
wait_and_tap 680 1550   # tap send

screenshot "step2_message_sent"
```

### Template: Coordinate Discovery

To find exact tap coordinates for the current device:

```bash
# Method 1: Enable pointer location in Developer Options
adb shell settings put system pointer_location 1
# Take screenshot, read coordinates, then disable:
adb shell settings put system pointer_location 0

# Method 2: Use getevent to capture real touches
adb shell getevent -l | grep -E "ABS_MT_POSITION"
# Touch the screen where needed, read X/Y from output

# Method 3: Screenshot + visual inspection
# Take screenshot, open it, estimate coordinates
# Device resolution: adb shell wm size
```

### Template: Scheduled Execution

```bash
#!/bin/bash
# Run an action every N minutes
INTERVAL=300  # 5 minutes

while true; do
  echo "[$(date)] Running automation..."
  
  # Your automation here
  adb shell screencap -p /sdcard/monitor.png
  adb pull /sdcard/monitor.png /tmp/monitor.png 2>/dev/null
  adb shell rm /sdcard/monitor.png
  
  echo "[$(date)] Next run in ${INTERVAL}s"
  sleep "$INTERVAL"
done
```

## Settings Manipulation

```bash
# Brightness (0-255)
adb shell settings put system screen_brightness 128

# Screen timeout (ms)
adb shell settings put system screen_off_timeout 300000   # 5 minutes

# WiFi on/off
adb shell svc wifi enable
adb shell svc wifi disable

# Mobile data on/off
adb shell svc data enable
adb shell svc data disable

# Bluetooth
adb shell settings put global bluetooth_on 1

# Do Not Disturb
adb shell settings put global zen_mode 1    # DND on
adb shell settings put global zen_mode 0    # DND off

# Rotation
adb shell settings put system accelerometer_rotation 0  # Lock
adb shell settings put system user_rotation 0           # Portrait
```

## Multi-Profile Automation

For devices with multiple user profiles, target specific users:

```bash
# Run activity as specific user
adb shell am start --user 10 -n com.whatsapp/com.whatsapp.Main

# Switch to user profile
adb shell am switch-user 10

# List running users
adb shell am get-current-user
```

## Coordinate Reference (720x1640 device)

For the POCO Serenity (720x1640, 320dpi):

| Area | Approximate Coordinates |
|------|------------------------|
| Status bar | y: 0-60 |
| App content start | y: 60 |
| Center screen | 360, 820 |
| Bottom nav bar | y: 1540-1640 |
| Back button | 180, 1600 |
| Home button | 360, 1600 |
| Recent apps | 540, 1600 |

Coordinates scale linearly with resolution. For other devices, multiply by
(device_width/720) and (device_height/1640).

## Additional Resources

- **`references/keycode-reference.md`** - Complete Android KEYCODE list
