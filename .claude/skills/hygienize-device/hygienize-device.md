---
name: hygienize-device
description: Hygienize a POCO C71 / Redmi A5 device by removing bloatware, silencing, setting always-on screen, removing locks, and restoring critical providers for WhatsApp automation.
---

# Hygienize Device Skill

Clean up a POCO C71 / Redmi A5 device for headless WhatsApp automation. Removes bloatware, configures silence, disables lock screens, and ensures WhatsApp dependencies are intact.

## When to use

- After initial device setup (Phase 5 of setup-device)
- After a factory reset that preserved user profiles
- When adding new user profiles that need cleanup
- The user says "hygienize", "clean device", "remove bloatware", or invokes `/hygienize-device`

## Prerequisites

- Device connected via ADB (`adb devices` shows `device` status)
- Root access via Magisk (`adb shell su -c id` returns `uid=0(root)`)
- User profiles already created (`adb shell pm list users`)

## Target Device

**Default serial (adjust as needed)**:
- Device 1: `9b01005930533036340030832250ac`
- Device 2: `9b0100593053303634003083239bac`

If multiple devices are connected, use `adb -s <SERIAL> ...` for all commands.

## Execution Steps

### Step 1: Identify Users

```bash
adb shell pm list users
```

Note the user IDs. Typical setup: 0, 10, 11, 12, 13, 14, 15, 16.

### Step 2: Remove Bloatware (Per User)

Run these two package removal loops for EACH user ID.

**Round 1 -- Major bloatware (70+ packages)**:

Push and run `/tmp/clean.sh` for each user:

```bash
for USER_ID in 0 10 11 12 13 14 15 16; do
  adb shell sh /tmp/clean.sh $USER_ID
done
```

The script removes: social media (Facebook, TikTok, LinkedIn, Kwai, Shopee), shopping (AliExpress, Amazon, Booking), Google apps (YouTube, Maps, Chrome, Gmail, Photos, Drive, Meet, Messages), Xiaomi/MIUI apps (Analytics, Bug Report, Calculator, Cleaner, Player, Scanner, Themes, Video, Discover, MiPicks, GLGM), media (Spotify, OneDrive), Android system (Calendar, FM Radio, MMS), and OEM test tools (Huaqin, Silead, Spreadtrum).

**Round 2 -- Additional packages (38 packages)**:

```bash
for USER_ID in 0 10 11 12 13 14 15 16; do
  adb shell sh /tmp/clean2.sh $USER_ID
done
```

Removes: Amazon Shopping, TikTok, NFC, Camera, system diagnostics, print services, wallpaper components, health services, and remaining OEM tools.

If the scripts are not on the device, push them first:
```bash
adb push /tmp/clean.sh /tmp/clean.sh
adb push /tmp/clean2.sh /tmp/clean2.sh
```

The full script contents and package lists are documented in `docs/device-setup/04-hygienization.md`.

### Step 3: Configure Settings (Per User)

```bash
for USER_ID in 0 10 11 12 13 14 15 16; do
  # Brightness max + manual mode
  adb shell content insert --uri content://settings/system --user $USER_ID \
    --bind name:s:screen_brightness --bind value:i:255
  adb shell content insert --uri content://settings/system --user $USER_ID \
    --bind name:s:screen_brightness_mode --bind value:i:0

  # Screen timeout infinite
  adb shell content insert --uri content://settings/system --user $USER_ID \
    --bind name:s:screen_off_timeout --bind value:i:2147483647

  # DND total silence
  adb shell content insert --uri content://settings/global --user $USER_ID \
    --bind name:s:zen_mode --bind value:i:2

  # Mute all volumes
  for STREAM in 0 1 2 3 4 5 6 7 8 9 10; do
    adb shell media volume --stream $STREAM --set 0 --user $USER_ID 2>/dev/null
  done
done
```

### Step 4: Remove Lock Screens (Requires Root)

```bash
for USER_ID in 0 10 11 12 13 14 15 16; do
  adb shell su -c "locksettings clear --old 12345 --user $USER_ID" 2>/dev/null
  adb shell su -c "locksettings clear --user $USER_ID" 2>/dev/null
  adb shell su -c "locksettings set-disabled true --user $USER_ID"
done
```

### Step 5: Restore Critical Providers

```bash
for USER_ID in 0 10 11 12 13 14 15 16; do
  adb shell pm install-existing --user $USER_ID com.android.providers.telephony 2>/dev/null
  adb shell pm install-existing --user $USER_ID com.android.phone 2>/dev/null
  adb shell pm install-existing --user $USER_ID com.android.providers.contacts 2>/dev/null
  adb shell pm install-existing --user $USER_ID com.android.contacts 2>/dev/null
  adb shell pm install-existing --user $USER_ID com.google.android.gms 2>/dev/null
  adb shell pm install-existing --user $USER_ID com.google.android.gsf 2>/dev/null
done
```

### Step 6: Global Device Settings

```bash
# Disable animations
adb shell settings put global window_animation_scale 0.0
adb shell settings put global transition_animation_scale 0.0
adb shell settings put global animator_duration_scale 0.0

# Stay awake while charging (USB + AC + Wireless)
adb shell settings put global stay_on_while_plugged_in 7

# Disable power saving
adb shell settings put global low_power 0
```

## Verification

```bash
# Package count (should be ~30-40, down from 130+)
adb shell pm list packages --user 0 | wc -l

# WhatsApp present
adb shell pm list packages --user 0 | grep whatsapp

# Brightness
adb shell settings get system screen_brightness
# Expected: 255

# Lock disabled
adb shell su -c "locksettings get-disabled --user 0"
# Expected: true

# Stay awake
adb shell settings get global stay_on_while_plugged_in
# Expected: 7

# Animations
adb shell settings get global window_animation_scale
# Expected: 0.0
```

## DO NOT REMOVE These Packages

The following packages are REQUIRED for WhatsApp to function:

- `com.google.android.gms` -- Google Play Services (FCM push notifications)
- `com.google.android.gsf` -- Google Services Framework
- `com.android.providers.telephony` -- SMS/MMS provider (2FA verification)
- `com.android.phone` -- Phone/telephony service
- `com.android.providers.contacts` -- Contacts provider
- `com.android.contacts` -- Contacts app
- `com.google.android.webview` -- WebView (used by WhatsApp for link previews)
- `com.android.providers.media` -- Media provider (file sharing)
- `com.android.providers.downloads` -- Downloads provider

## Estimated Time

~30 minutes per device (all users).
