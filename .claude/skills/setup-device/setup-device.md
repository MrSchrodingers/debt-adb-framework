---
name: setup-device
description: Set up a new POCO C71 / Redmi A5 device from scratch for the Dispatch ADB Framework. Covers bootloader unlock, root, multi-user creation, hygienization, and WhatsApp installation across all profiles.
---

# Setup Device Skill

Guide the operator through the full setup process for a new POCO C71 / Redmi A5 device for the Dispatch ADB Framework phone farm.

## When to use

- A new POCO C71 or Redmi A5 device needs to be added to the farm
- A device needs to be re-setup from scratch after a factory reset
- The user says "setup device", "new device", "add device to farm", or invokes `/setup-device`

## Prerequisites Check

Before starting, verify:

1. **Windows PC available** -- bootloader unlock requires Windows (native, not VM/Wine)
2. **USB cable** -- data-capable USB-A to USB-C
3. **Downloads ready**:
   - spd_dump.exe from https://github.com/TomKing062/CVE-2022-38694_unlock_bootloader/releases/tag/1.72
   - `ums9230e_Tecno_KL4.zip` FDL package (NOT `ums9230_universal_unlock_EMMC.zip`)
   - Spreadtrum USB driver for Windows
   - Recovery ROM: `https://bigota.d.miui.com/A15.0.13.0.VGWMIXM/miui_SERENITYGlobal_A15.0.13.0.VGWMIXM_1478ff1e33_15.0.zip`
   - Magisk v28.1 APK
   - payload_dumper (pip package)

## Setup Pipeline (6 Phases)

Execute each phase in order. Do not skip phases.

### Phase 1: Bootloader Unlock (Windows)

Reference: `docs/device-setup/01-bootloader-unlock.md`

1. Install Spreadtrum USB driver on Windows
2. Extract `ums9230e_Tecno_KL4.zip` to `C:\cve-unlock\emmc\`
3. Power off device, hold Volume Down, connect USB
4. Run: `spd_dump.exe --kickto-fastboot emmc\fdl1-dl.bin emmc\fdl2-dl.bin`
5. Run: `fastboot oem unlock`
6. Verify: `fastboot getvar unlocked` shows `yes`
7. Reboot and complete initial Android setup

**CRITICAL**: Use `ums9230e_Tecno_KL4.zip`, NOT `ums9230_universal_unlock_EMMC.zip`. The device chipset is UMS9230E (T615), not UMS9230.

### Phase 2: Root via Magisk

Reference: `docs/device-setup/02-root-magisk.md`

1. Extract boot.img: `payload_dumper --partitions boot payload.bin`
2. Install Magisk v28.1 on device: `adb install Magisk-v28.1.apk`
3. Push boot.img: `adb push output/boot.img /sdcard/Download/boot.img`
4. Patch with Magisk app on device (Select and Patch a File)
5. Pull patched image: `adb pull /sdcard/Download/magisk_patched-*.img magisk_patched.img`
6. Flash: `adb reboot bootloader && fastboot flash boot_a magisk_patched.img && fastboot reboot`
7. Verify: `adb shell su -c id` shows `uid=0(root)`
8. Configure DenyList for WhatsApp in Magisk settings

### Phase 3: Multi-User Setup

Reference: `docs/device-setup/03-multi-user-setup.md`

1. Increase user limit: `adb shell su -c "setprop fw.max_users 8"`
2. Make persistent:
   ```bash
   adb shell su -c "mkdir -p /data/adb/post-fs-data.d"
   adb shell su -c "echo 'resetprop fw.max_users 8' > /data/adb/post-fs-data.d/max_users.sh"
   adb shell su -c "chmod 755 /data/adb/post-fs-data.d/max_users.sh"
   ```
3. Create users:
   ```bash
   adb shell pm create-user "Name 1"
   adb shell pm create-user "Name 2"
   adb shell pm create-user "Name 3"
   adb shell pm create-user --profileOf 0 --managed "Work"
   adb shell pm create-user "Name 5"
   adb shell pm create-user "Name 6"
   adb shell pm create-user "Name 7"
   ```
4. Start all users: `for UID in 10 11 12 13 14 15 16; do adb shell am start-user $UID; done`
5. Create auto-start boot script in `/data/adb/service.d/start_users.sh`

### Phase 4: Install WhatsApp on All Profiles

```bash
for USER_ID in 10 11 12 13 14 15 16; do
  adb shell pm install-existing --user $USER_ID com.whatsapp
  adb shell pm install-existing --user $USER_ID com.whatsapp.w4b
done
```

### Phase 5: Hygienize Device

Reference: `docs/device-setup/04-hygienization.md`

Use the `/hygienize-device` skill or run the hygienization script manually for all users.

### Phase 6: Configure WhatsApp Numbers

For each user profile:
1. Switch to user: `adb shell am switch-user <UID>`
2. Open WhatsApp, complete phone verification via SMS
3. For Work Profile (user 13): open the briefcase-badged WhatsApp icon (no switch needed)

## Verification

After setup is complete, run these checks:

```bash
# All users exist and running
adb shell pm list users

# WhatsApp installed for all users
for UID in 0 10 11 12 13 14 15 16; do
  echo "User $UID:"
  adb shell pm list packages --user $UID | grep whatsapp
done

# Root works
adb shell su -c id

# Lock screens disabled
for UID in 0 10 11 12 13 14 15 16; do
  adb shell su -c "locksettings get-disabled --user $UID"
done

# Parallel processes (User 0 + Work Profile 13)
adb shell ps -A | grep whatsapp
```

## Record the Device

After setup, record the device in `.dev-state/device-backup-map.md`:
- Device serial
- User ID to WhatsApp number mapping
- WA Business number mapping
- Google account per profile (for backup)

## Estimated Time

- Bootloader unlock: 30 minutes (includes download time)
- Root: 20 minutes
- Multi-user: 15 minutes
- Hygienize: 30 minutes
- WhatsApp config: 30-60 minutes (depends on number of SIMs/SMS verification)
- **Total: ~2-3 hours per device**
