# Device Hygienization -- Bloatware Removal, Silence, Lock Removal

> **Prerequisite**: Multi-user setup complete (see `03-multi-user-setup.md`)
> **Device**: POCO C71 / Redmi A5, codename "serenity"
> **Scope**: All user profiles (0, 10, 11, 12, 13, 14, 15, 16)
> **Time**: ~30 minutes (per device, all profiles)

---

## Overview

Hygienization prepares each device for headless WhatsApp automation by:

1. **Removing bloatware** -- frees RAM and storage, prevents background noise
2. **Silencing the device** -- all volumes to 0, DND enabled
3. **Setting screen always-on** -- infinite timeout, max brightness
4. **Removing lock screens** -- no PIN/pattern delays during automation
5. **Restoring critical providers** -- SMS for 2FA, Contacts for WhatsApp

---

## Step 1: Bloatware Removal

Bloatware is removed per-user (not system-wide) using `pm uninstall -k --user`. This keeps the package on the system partition but removes it from the user's profile, freeing RAM and preventing background services.

### Round 1: Major Bloatware (per user)

This script removes 70+ packages including social media, Xiaomi services, Google apps not needed for WhatsApp, OEM test tools, and media apps.

```bash
#!/system/bin/sh
# Usage: sh clean.sh <USER_ID>
# Example: sh clean.sh 0
UID=$1
REMOVED=0
for PKG in \
  com.alibaba.aliexpresshd \
  com.amazon.appmanager \
  com.booking \
  com.facebook.appmanager \
  com.facebook.katana \
  com.facebook.services \
  com.facebook.system \
  com.go.browser \
  com.google.ambient.streaming \
  com.kwai.video \
  com.linkedin.android \
  com.microsoft.skydrive \
  com.mi.globalminusscreen \
  com.miui.analytics.go \
  com.miui.bugreport \
  com.miui.calculator.go \
  com.miui.cleaner.go \
  com.miui.gameCenter.overlay \
  com.miui.msa.global \
  com.miui.player \
  com.miui.player.overlay \
  com.miui.qr \
  com.miui.scanner.overlay \
  com.miui.theme.lite \
  com.miui.videoplayer \
  com.miui.videoplayer.overlay \
  com.shopee.br \
  com.spotify.music \
  com.google.android.apps.youtube.music \
  com.google.android.youtube \
  com.google.android.apps.maps \
  com.google.android.apps.photosgo \
  com.google.android.apps.walletnfcrel \
  com.android.chrome \
  com.google.android.apps.docs \
  com.google.android.apps.messaging \
  com.google.android.apps.nbu.files \
  com.google.android.apps.restore \
  com.google.android.apps.safetyhub \
  com.google.android.apps.searchlite \
  com.google.android.apps.subscriptions.red \
  com.google.android.apps.tachyon \
  com.google.android.apps.wellbeing \
  com.google.android.feedback \
  com.google.android.gm \
  com.google.android.marvin.talkback \
  com.google.android.videos \
  com.google.android.safetycore \
  com.google.android.gms.supervision \
  com.unisoc.phone \
  com.android.mms.service \
  com.android.calendar.go \
  com.android.fmradio \
  com.mi.AutoTest \
  com.mi.globallayout \
  com.huaqin.factory \
  com.huaqin.sarcontroller \
  com.silead.factorytest \
  com.sprd.camta \
  com.sprd.omacp \
  com.sprd.powersavemodelauncher \
  com.sprd.uasetting \
  com.miui.android.fashiongallery \
  com.xiaomi.discover \
  com.xiaomi.mipicks \
  com.xiaomi.scanner \
  com.xiaomi.glgm; do
  RESULT=$(pm uninstall -k --user $UID $PKG 2>&1)
  case "$RESULT" in *Success*) REMOVED=$((REMOVED+1));; esac
done
echo "P${UID}: ${REMOVED} removidos"
```

### Round 2: Additional Bloatware (per user)

A second pass catches remaining packages including Amazon, TikTok, development tools, NFC, camera (not needed for headless), and system diagnostics.

```bash
#!/system/bin/sh
# Usage: sh clean2.sh <USER_ID>
# Example: sh clean2.sh 0
UID=$1
REMOVED=0
for PKG in \
  com.amazon.mShop.android.shopping \
  com.zhiliaoapp.musically \
  com.xiaomi.midrop \
  com.android.stk \
  com.android.bookmarkprovider \
  com.android.egg \
  com.android.dreams.basic \
  com.android.musicfx \
  com.android.printspooler \
  com.android.bips \
  com.android.avatarpicker \
  com.android.DeviceAsWebcam \
  com.android.devicediagnostics \
  com.android.htmlviewer \
  com.android.wallpapercropper \
  com.android.wallpaperbackup \
  com.android.wallpaper \
  com.android.traceur \
  com.android.deskclock.go \
  com.google.android.printservice.recommendation \
  com.google.android.as.oss \
  com.google.android.federatedcompute \
  com.google.android.devicelockcontroller \
  com.google.android.ondevicepersonalization.services \
  com.google.android.health.connect.backuprestore \
  com.google.android.healthconnect.controller \
  com.google.android.overlay.devicelockcontroller \
  com.goodix.gftest \
  com.bsp.logmanager \
  com.sprd.logmanager \
  com.sprd.validationtools \
  com.sprd.cameracalibration \
  com.sprd.engineermode \
  com.sprd.linkturbo \
  com.tencent.soter.soterserver \
  com.mi.android.globalFileexplorer.overlay \
  com.android.nfc \
  com.android.camera \
  com.android.camera.overlay; do
  RESULT=$(pm uninstall -k --user $UID $PKG 2>&1)
  case "$RESULT" in *Success*) REMOVED=$((REMOVED+1));; esac
done
echo "P${UID}: ${REMOVED} removidos"
```

### Run Both Scripts for All Users

Push the scripts to the device and run them:

```bash
# Push scripts
adb push clean.sh /tmp/clean.sh
adb push clean2.sh /tmp/clean2.sh

# Run for all users
for USER_ID in 0 10 11 12 13 14 15 16; do
  echo "=== Cleaning User $USER_ID ==="
  adb shell sh /tmp/clean.sh $USER_ID
  adb shell sh /tmp/clean2.sh $USER_ID
done
```

**Expected output**:
```
=== Cleaning User 0 ===
P0: 52 removidos
P0: 28 removidos
=== Cleaning User 10 ===
P10: 48 removidos
P10: 25 removidos
...
```

The exact count varies per user (some packages are already absent on secondary profiles).

---

## Complete Bloatware Package List

For reference, here is the FULL list of 108 packages removed across both rounds, categorized:

### Social Media & Shopping (9 packages)
| Package | App |
|---------|-----|
| `com.alibaba.aliexpresshd` | AliExpress |
| `com.amazon.appmanager` | Amazon App Manager |
| `com.amazon.mShop.android.shopping` | Amazon Shopping |
| `com.booking` | Booking.com |
| `com.facebook.katana` | Facebook |
| `com.kwai.video` | Kwai |
| `com.linkedin.android` | LinkedIn |
| `com.shopee.br` | Shopee |
| `com.zhiliaoapp.musically` | TikTok |

### Facebook System Services (2 packages)
| Package | App |
|---------|-----|
| `com.facebook.appmanager` | Facebook App Manager |
| `com.facebook.services` | Facebook Services |
| `com.facebook.system` | Facebook System |

### Google Apps (20 packages)
| Package | App |
|---------|-----|
| `com.android.chrome` | Chrome |
| `com.google.ambient.streaming` | Ambient Streaming |
| `com.google.android.apps.docs` | Google Docs |
| `com.google.android.apps.maps` | Google Maps |
| `com.google.android.apps.messaging` | Google Messages |
| `com.google.android.apps.nbu.files` | Files by Google |
| `com.google.android.apps.photosgo` | Google Photos Go |
| `com.google.android.apps.restore` | Google Restore |
| `com.google.android.apps.safetyhub` | Personal Safety |
| `com.google.android.apps.searchlite` | Google Search Lite |
| `com.google.android.apps.subscriptions.red` | Google One |
| `com.google.android.apps.tachyon` | Google Duo/Meet |
| `com.google.android.apps.walletnfcrel` | Google Wallet |
| `com.google.android.apps.wellbeing` | Digital Wellbeing |
| `com.google.android.apps.youtube.music` | YouTube Music |
| `com.google.android.feedback` | Google Feedback |
| `com.google.android.gm` | Gmail |
| `com.google.android.marvin.talkback` | TalkBack |
| `com.google.android.safetycore` | Safety Core |
| `com.google.android.videos` | Google TV |
| `com.google.android.youtube` | YouTube |

### Google System Services (7 packages)
| Package | App |
|---------|-----|
| `com.google.android.as.oss` | Private Compute Services |
| `com.google.android.devicelockcontroller` | Device Lock Controller |
| `com.google.android.federatedcompute` | Federated Compute |
| `com.google.android.gms.supervision` | Family Link |
| `com.google.android.health.connect.backuprestore` | Health Connect Backup |
| `com.google.android.healthconnect.controller` | Health Connect |
| `com.google.android.ondevicepersonalization.services` | Personalization Services |
| `com.google.android.overlay.devicelockcontroller` | Device Lock Overlay |
| `com.google.android.printservice.recommendation` | Print Service |

### Xiaomi / MIUI / HyperOS (14 packages)
| Package | App |
|---------|-----|
| `com.mi.AutoTest` | Mi AutoTest |
| `com.mi.globalminusscreen` | Mi Minus Screen |
| `com.mi.globallayout` | Mi Global Layout |
| `com.mi.android.globalFileexplorer.overlay` | File Explorer Overlay |
| `com.miui.analytics.go` | MIUI Analytics |
| `com.miui.bugreport` | MIUI Bug Report |
| `com.miui.calculator.go` | Calculator |
| `com.miui.cleaner.go` | Cleaner |
| `com.miui.gameCenter.overlay` | Game Center |
| `com.miui.msa.global` | MIUI System Ads |
| `com.miui.player` | Mi Music |
| `com.miui.player.overlay` | Mi Music Overlay |
| `com.miui.qr` | Mi QR Scanner |
| `com.miui.scanner.overlay` | Scanner Overlay |
| `com.miui.theme.lite` | Themes |
| `com.miui.videoplayer` | Mi Video |
| `com.miui.videoplayer.overlay` | Mi Video Overlay |
| `com.miui.android.fashiongallery` | Wallpaper Carousel |
| `com.xiaomi.discover` | Mi Community |
| `com.xiaomi.glgm` | Xiaomi Games |
| `com.xiaomi.midrop` | Mi Drop |
| `com.xiaomi.mipicks` | Mi Picks (GetApps) |
| `com.xiaomi.scanner` | Xiaomi Scanner |

### Streaming & Media (2 packages)
| Package | App |
|---------|-----|
| `com.microsoft.skydrive` | OneDrive |
| `com.spotify.music` | Spotify |

### Android System (not needed for automation) (19 packages)
| Package | App |
|---------|-----|
| `com.android.bookmarkprovider` | Bookmark Provider |
| `com.android.bips` | Default Print Service |
| `com.android.calendar.go` | Calendar |
| `com.android.camera` | Camera |
| `com.android.camera.overlay` | Camera Overlay |
| `com.android.deskclock.go` | Clock |
| `com.android.DeviceAsWebcam` | Device as Webcam |
| `com.android.devicediagnostics` | Device Diagnostics |
| `com.android.dreams.basic` | Basic Daydreams |
| `com.android.egg` | Android Easter Egg |
| `com.android.fmradio` | FM Radio |
| `com.android.htmlviewer` | HTML Viewer |
| `com.android.mms.service` | MMS Service |
| `com.android.musicfx` | Music FX |
| `com.android.nfc` | NFC Service |
| `com.android.printspooler` | Print Spooler |
| `com.android.stk` | SIM Toolkit |
| `com.android.traceur` | System Tracing |
| `com.android.wallpaper` | Wallpaper |
| `com.android.wallpaperbackup` | Wallpaper Backup |
| `com.android.wallpapercropper` | Wallpaper Cropper |
| `com.android.avatarpicker` | Avatar Picker |
| `com.go.browser` | Go Browser |

### Unisoc / Spreadtrum OEM Tools (8 packages)
| Package | App |
|---------|-----|
| `com.huaqin.factory` | Factory Test (Huaqin) |
| `com.huaqin.sarcontroller` | SAR Controller |
| `com.silead.factorytest` | Fingerprint Factory Test |
| `com.sprd.camta` | Camera Test App |
| `com.sprd.omacp` | OMA CP |
| `com.sprd.powersavemodelauncher` | Power Save Launcher |
| `com.sprd.uasetting` | UA Setting |
| `com.sprd.logmanager` | Log Manager |
| `com.sprd.validationtools` | Validation Tools |
| `com.sprd.cameracalibration` | Camera Calibration |
| `com.sprd.engineermode` | Engineer Mode |
| `com.sprd.linkturbo` | Link Turbo |
| `com.bsp.logmanager` | BSP Log Manager |
| `com.unisoc.phone` | Unisoc Phone |

### Other (3 packages)
| Package | App |
|---------|-----|
| `com.goodix.gftest` | Goodix Fingerprint Test |
| `com.tencent.soter.soterserver` | Tencent SOTER (biometric) |

---

## Step 2: Configure Device Settings (Per User)

These settings must be applied to EACH user profile individually.

### Screen Brightness to Maximum

```bash
# Set brightness to maximum (255) for each user
for USER_ID in 0 10 11 12 13 14 15 16; do
  adb shell content insert --uri content://settings/system --user $USER_ID \
    --bind name:s:screen_brightness --bind value:i:255
  adb shell content insert --uri content://settings/system --user $USER_ID \
    --bind name:s:screen_brightness_mode --bind value:i:0
done
```

- `screen_brightness=255` = maximum brightness
- `screen_brightness_mode=0` = manual brightness (disable auto)

### Screen Timeout to Infinite

```bash
# Set screen timeout to never (max value = 2147483647 ms ≈ 24.8 days)
for USER_ID in 0 10 11 12 13 14 15 16; do
  adb shell content insert --uri content://settings/system --user $USER_ID \
    --bind name:s:screen_off_timeout --bind value:i:2147483647
done
```

### All Volumes to Zero

```bash
# Mute all audio streams for each user
for USER_ID in 0 10 11 12 13 14 15 16; do
  for STREAM in 0 1 2 3 4 5 6 7 8 9 10; do
    adb shell media volume --stream $STREAM --set 0 --user $USER_ID 2>/dev/null
  done
done
```

Stream IDs:
- 0 = Voice call
- 1 = System
- 2 = Ring
- 3 = Music
- 4 = Alarm
- 5 = Notification
- 6-10 = Other streams

### Enable Do Not Disturb

```bash
for USER_ID in 0 10 11 12 13 14 15 16; do
  adb shell content insert --uri content://settings/global --user $USER_ID \
    --bind name:s:zen_mode --bind value:i:2
done
```

- `zen_mode=0` = Off
- `zen_mode=1` = Priority only
- `zen_mode=2` = Total silence
- `zen_mode=3` = Alarms only

---

## Step 3: Remove Lock Screens

Lock screens cause delays during user switching and block ADB automation. Remove them for all profiles.

### Clear existing PIN/Password

If a PIN was set (e.g., `12345`):

```bash
# Must run as root
for USER_ID in 0 10 11 12 13 14 15 16; do
  adb shell su -c "locksettings clear --old 12345 --user $USER_ID"
done
```

**Expected output** for each:
```
Lock credential cleared
```

If the PIN is different or was never set, adjust the `--old` value accordingly. For no existing PIN, use:

```bash
adb shell su -c "locksettings clear --user $USER_ID"
```

### Disable lock screen entirely

```bash
for USER_ID in 0 10 11 12 13 14 15 16; do
  adb shell su -c "locksettings set-disabled true --user $USER_ID"
done
```

**Expected output** for each:
```
Lock screen disabled
```

### Verify lock screen is disabled

```bash
for USER_ID in 0 10 11 12 13 14 15 16; do
  echo "User $USER_ID:"
  adb shell su -c "locksettings get-disabled --user $USER_ID"
done
```

**Expected output** for each:
```
User 0:
true
```

---

## Step 4: Restore Critical Providers

The bloatware removal scripts may accidentally remove or interfere with providers that WhatsApp needs.

### Restore SMS/MMS Provider (for 2FA verification)

WhatsApp requires SMS capability for initial phone number verification.

```bash
# Ensure telephony and SMS providers are available
for USER_ID in 0 10 11 12 13 14 15 16; do
  adb shell pm install-existing --user $USER_ID com.android.providers.telephony
  adb shell pm install-existing --user $USER_ID com.android.phone
done
```

### Restore Contacts Provider (for WhatsApp contact sync)

WhatsApp reads contacts to show names in chats. The contacts provider must be available.

```bash
for USER_ID in 0 10 11 12 13 14 15 16; do
  adb shell pm install-existing --user $USER_ID com.android.providers.contacts
  adb shell pm install-existing --user $USER_ID com.android.contacts
done
```

### Restore Google Play Services (required by WhatsApp)

WhatsApp depends on Google Play Services for push notifications (FCM) and other functionality.

```bash
for USER_ID in 0 10 11 12 13 14 15 16; do
  adb shell pm install-existing --user $USER_ID com.google.android.gms
  adb shell pm install-existing --user $USER_ID com.google.android.gsf
done
```

---

## Step 5: Disable Animations (Speed Up UI)

Reducing or disabling animations speeds up user switching and app transitions.

```bash
adb shell settings put global window_animation_scale 0.0
adb shell settings put global transition_animation_scale 0.0
adb shell settings put global animator_duration_scale 0.0
```

---

## Step 6: Keep Screen Awake While Charging

Since the devices are always plugged in (USB for ADB):

```bash
# Stay awake while charging (bitmask: 1=AC, 2=USB, 4=Wireless)
adb shell settings put global stay_on_while_plugged_in 7
```

Value `7` = AC + USB + Wireless (all charging sources keep screen on).

---

## Step 7: Disable Power Saving

Power saving mode throttles CPU and background processes, which interferes with automation.

```bash
adb shell settings put global low_power 0
adb shell su -c "cmd power set-adaptive-power-saver-enabled false"
```

---

## Verification Checklist

After completing all hygienization steps, verify:

```bash
# 1. Check bloatware is gone (should show only essential + WhatsApp packages)
adb shell pm list packages --user 0 | wc -l
# Expected: ~30-40 packages (down from 130+)

# 2. Check brightness
adb shell settings get system screen_brightness
# Expected: 255

# 3. Check timeout
adb shell settings get system screen_off_timeout
# Expected: 2147483647

# 4. Check DND
adb shell settings get global zen_mode
# Expected: 2

# 5. Check lock disabled
adb shell su -c "locksettings get-disabled --user 0"
# Expected: true

# 6. Check animations disabled
adb shell settings get global window_animation_scale
# Expected: 0.0

# 7. Check stay awake
adb shell settings get global stay_on_while_plugged_in
# Expected: 7

# 8. Check WhatsApp is present
adb shell pm list packages --user 0 | grep whatsapp
# Expected:
# package:com.whatsapp
# package:com.whatsapp.w4b

# 9. Verify SMS provider
adb shell pm list packages --user 0 | grep telephony
# Expected: package:com.android.providers.telephony
```

---

## Complete Hygienization Script (All-in-One)

For convenience, here is a combined script that performs all hygienization steps for all users:

```bash
#!/bin/bash
# hygienize-device.sh
# Run from PC with device connected via ADB
# Usage: ./hygienize-device.sh

USERS="0 10 11 12 13 14 15 16"

echo "=== POCO C71 Hygienization ==="
echo "Users: $USERS"

# Push cleanup scripts
adb push clean.sh /tmp/clean.sh
adb push clean2.sh /tmp/clean2.sh

# Round 1: Bloatware removal
echo ""
echo "--- Round 1: Major Bloatware ---"
for UID in $USERS; do
  adb shell sh /tmp/clean.sh $UID
done

# Round 2: Additional bloatware
echo ""
echo "--- Round 2: Additional Bloatware ---"
for UID in $USERS; do
  adb shell sh /tmp/clean2.sh $UID
done

# Settings per user
echo ""
echo "--- Configuring Settings ---"
for UID in $USERS; do
  echo "Configuring User $UID..."

  # Brightness max
  adb shell content insert --uri content://settings/system --user $UID \
    --bind name:s:screen_brightness --bind value:i:255
  adb shell content insert --uri content://settings/system --user $UID \
    --bind name:s:screen_brightness_mode --bind value:i:0

  # Timeout infinite
  adb shell content insert --uri content://settings/system --user $UID \
    --bind name:s:screen_off_timeout --bind value:i:2147483647

  # DND total silence
  adb shell content insert --uri content://settings/global --user $UID \
    --bind name:s:zen_mode --bind value:i:2

  # Mute all volumes
  for STREAM in 0 1 2 3 4 5 6 7 8 9 10; do
    adb shell media volume --stream $STREAM --set 0 --user $UID 2>/dev/null
  done

  # Clear lock and disable
  adb shell su -c "locksettings clear --old 12345 --user $UID" 2>/dev/null
  adb shell su -c "locksettings set-disabled true --user $UID"

  # Restore critical providers
  adb shell pm install-existing --user $UID com.android.providers.telephony 2>/dev/null
  adb shell pm install-existing --user $UID com.android.phone 2>/dev/null
  adb shell pm install-existing --user $UID com.android.providers.contacts 2>/dev/null
  adb shell pm install-existing --user $UID com.android.contacts 2>/dev/null
  adb shell pm install-existing --user $UID com.google.android.gms 2>/dev/null
  adb shell pm install-existing --user $UID com.google.android.gsf 2>/dev/null
done

# Global settings (device-wide)
echo ""
echo "--- Global Settings ---"
adb shell settings put global window_animation_scale 0.0
adb shell settings put global transition_animation_scale 0.0
adb shell settings put global animator_duration_scale 0.0
adb shell settings put global stay_on_while_plugged_in 7
adb shell settings put global low_power 0

echo ""
echo "=== Hygienization Complete ==="
```
