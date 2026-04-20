---
name: adb-whatsapp
description: >
  This skill should be used when the user asks to "manage whatsapp via adb",
  "whatsapp automation", "open whatsapp", "send whatsapp message", "whatsapp backup",
  "check whatsapp", "whatsapp profiles", "switch whatsapp account", "whatsapp status",
  "whatsapp notifications", "whatsapp multi-device", "multiple whatsapp accounts",
  or wants to interact with WhatsApp/WhatsApp Business on an Android device via ADB.
---

# ADB WhatsApp Manager

Manage WhatsApp and WhatsApp Business across multiple user profiles via ADB.
Supports multi-account setups (multiple user profiles with WA + WA Business each).

## Package Names

| App | Package | Main Activity |
|-----|---------|---------------|
| WhatsApp | `com.whatsapp` | `com.whatsapp.Main` |
| WhatsApp Business | `com.whatsapp.w4b` | `com.whatsapp.Main` |

**Note:** WA Business uses `com.whatsapp.Main` as activity (not `com.whatsapp.w4b.Main`).

## Multi-Account Architecture

This device uses multiple Android user profiles for multiple WhatsApp accounts:

```
User 0  (Main)     -> WhatsApp + WA Business = 2 accounts
User 10 (Profile 2) -> WhatsApp + WA Business = 2 accounts
User 12 (Profile 3) -> WhatsApp + WA Business = 2 accounts
                                        Total = 6-8 accounts
```

List profiles: `adb shell pm list users`

## Common Operations

### Launch WhatsApp

```bash
# WhatsApp on main user
adb shell am start -n com.whatsapp/com.whatsapp.Main

# WhatsApp Business on main user
adb shell am start -n com.whatsapp.w4b/com.whatsapp.Main

# WhatsApp on specific user profile
adb shell am start --user 10 -n com.whatsapp/com.whatsapp.Main
```

### Check WhatsApp Status

```bash
# Verify both are installed
adb shell pm list packages | grep whatsapp

# Check running state
adb shell "dumpsys activity processes" | grep whatsapp

# Check version
adb shell dumpsys package com.whatsapp | grep versionName
adb shell dumpsys package com.whatsapp.w4b | grep versionName

# Check storage usage
adb shell du -sh /data/data/com.whatsapp 2>/dev/null
adb shell du -sh /data/data/com.whatsapp.w4b 2>/dev/null

# WhatsApp media storage
adb shell du -sh /sdcard/Android/media/com.whatsapp 2>/dev/null
adb shell du -sh /sdcard/Android/media/com.whatsapp.w4b 2>/dev/null
```

### Notification Management

```bash
# Check active WhatsApp notifications
adb shell "dumpsys notification --noredact" | grep -A5 "pkg=com.whatsapp"

# Count unread notifications
adb shell "dumpsys notification --noredact" | grep -c "pkg=com.whatsapp[^.]"

# Dismiss all notifications
adb shell service call notification 1
```

### Force Stop / Clear

```bash
# Force stop (kills background process)
adb shell am force-stop com.whatsapp

# Clear cache only (keeps messages)
adb shell pm clear --cache-only com.whatsapp

# DANGER: Clear ALL data (loses messages unless backed up)
adb shell pm clear com.whatsapp
```

### Backup WhatsApp Data

```bash
# Pull WhatsApp database (may require root for full access)
adb pull /sdcard/Android/media/com.whatsapp/WhatsApp/ /tmp/whatsapp-backup/

# Pull WhatsApp Business database
adb pull /sdcard/Android/media/com.whatsapp.w4b/WhatsApp\ Business/ /tmp/wab-backup/

# Backup APK
adb shell pm path com.whatsapp | sed 's/package://'
# Then: adb pull <path> /tmp/whatsapp.apk
```

### Send Message via Intent (opens chat)

```bash
# Open chat with specific number (URL scheme)
adb shell am start -a android.intent.action.VIEW -d "https://wa.me/5511999999999"

# Open WhatsApp Business chat
adb shell am start -a android.intent.action.VIEW -d "https://wa.me/5511999999999" -p com.whatsapp.w4b
```

### Screenshot WhatsApp

```bash
# Open WhatsApp then screenshot
adb shell am start -n com.whatsapp/com.whatsapp.Main
sleep 2
adb shell screencap -p /sdcard/wa_screen.png
adb pull /sdcard/wa_screen.png /tmp/
adb shell rm /sdcard/wa_screen.png
```

## Automation Patterns

### Auto-respond workflow (via UI automation)

```bash
# 1. Wake screen
adb shell input keyevent KEYCODE_WAKEUP

# 2. Swipe up to unlock (adjust coordinates for device)
adb shell input swipe 360 1400 360 600

# 3. Open WhatsApp
adb shell am start -n com.whatsapp/com.whatsapp.Main
sleep 2

# 4. Tap on a chat (coordinates depend on screen layout)
adb shell input tap 360 300

# 5. Tap message field
adb shell input tap 360 1550

# 6. Type message
adb shell input text "Hello"

# 7. Tap send button
adb shell input tap 680 1550
```

**Note:** UI automation via input commands is fragile. Coordinates depend on screen
resolution (this device: 720x1640). Always verify with screenshots.

## Multi-Profile Operations

### Check WhatsApp across all profiles

```bash
for user in 0 10 12; do
  echo "=== User $user ==="
  adb shell pm list packages --user $user 2>/dev/null | grep whatsapp
done
```

### Update WhatsApp on all profiles

After updating from Play Store on main profile, the update applies to all profiles
automatically (shared APK, separate data).

## Permissions Check

```bash
# List WhatsApp permissions
adb shell dumpsys package com.whatsapp | grep "granted=true" | grep "android.permission"
```

Critical permissions for WhatsApp:
- `CAMERA` - Photos/video calls
- `RECORD_AUDIO` - Voice messages/calls
- `READ_CONTACTS` - Contact list
- `ACCESS_FINE_LOCATION` - Location sharing
- `READ_EXTERNAL_STORAGE` - Media access
- `RECEIVE_SMS` - Auto-verification

## Additional Resources

- **`references/whatsapp-intents.md`** - Complete list of WhatsApp intents and deep links
