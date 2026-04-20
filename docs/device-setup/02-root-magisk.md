# Root via Magisk -- POCO C71 / Redmi A5 (Serenity)

> **Prerequisite**: Bootloader unlocked (see `01-bootloader-unlock.md`)
> **Device**: POCO C71 / Redmi A5, codename "serenity", model 25028PC03G
> **Firmware**: A15.0.13.0.VGWMIXM (Android 15)
> **Magisk Version**: v28.1
> **Boot Partition**: boot_a (Slot A)
> **Time**: ~20 minutes

---

## Overview

The rooting process for the POCO C71:

1. Download the official Recovery ROM ZIP
2. Extract `payload.bin` from the ZIP
3. Extract `boot.img` from `payload.bin`
4. Push `boot.img` to the device
5. Patch it with the Magisk app on-device
6. Pull the patched image back to the PC
7. Flash the patched image to `boot_a` via fastboot
8. Verify root access

---

## Step 1: Download the Recovery ROM

Download the official Xiaomi Recovery ROM for the serenity device.

**Direct CDN link**:
```
https://bigota.d.miui.com/A15.0.13.0.VGWMIXM/miui_SERENITYGlobal_A15.0.13.0.VGWMIXM_1478ff1e33_15.0.zip
```

**MD5**: `1478ff1e33f15a12a6a082e5c3e142b8`

**Verify the download**:
```bash
md5sum miui_SERENITYGlobal_A15.0.13.0.VGWMIXM_1478ff1e33_15.0.zip
# Expected: 1478ff1e33f15a12a6a082e5c3e142b8
```

**Alternative**: If the CDN link is down, search for the ROM on:
- https://xiaomifirmwareupdater.com/ (search for "serenity")
- https://mifirm.net/

---

## Step 2: Extract payload.bin from the ZIP

The Recovery ROM is a ZIP file containing a `payload.bin` file (A/B OTA format).

```bash
# Create working directory
mkdir -p /tmp/magisk-root && cd /tmp/magisk-root

# Extract only payload.bin (the ZIP is large, no need to extract everything)
unzip -o /path/to/miui_SERENITYGlobal_A15.0.13.0.VGWMIXM_1478ff1e33_15.0.zip payload.bin

# Verify
ls -lh payload.bin
# Should be several GB
```

---

## Step 3: Extract boot.img from payload.bin

Use `payload_dumper` to extract only the boot partition image.

### Install payload_dumper

```bash
pip install payload_dumper
```

Or if using pipx:
```bash
pipx install payload_dumper
```

### Extract boot.img

```bash
payload_dumper --partitions boot payload.bin
```

**Expected output**:
```
Extracting boot partition...
Extracted: output/boot.img
```

The extracted file will be at `output/boot.img` (relative to current directory).

**Verify**:
```bash
ls -lh output/boot.img
# Should be ~64-128 MB
file output/boot.img
# Should show: Android bootimg, ...
```

---

## Step 4: Install Magisk on the device

1. Download Magisk v28.1 APK from: https://github.com/topjohnwu/Magisk/releases/tag/v28.1
2. Install it on the device:

```bash
adb install Magisk-v28.1.apk
```

**Expected output**:
```
Performing Streamed Install
Success
```

If ADB is not authorized, see `06-adb-troubleshooting.md`.

---

## Step 5: Push boot.img to the device

```bash
adb push output/boot.img /sdcard/Download/boot.img
```

**Expected output**:
```
output/boot.img: 1 file pushed. X.X MB/s (XXXXX bytes in X.XXXs)
```

---

## Step 6: Patch boot.img with Magisk

1. Open the **Magisk** app on the device
2. Tap **Install** (next to "Magisk" at the top)
3. Select **Select and Patch a File**
4. Navigate to `Download` folder
5. Select `boot.img`
6. Wait for patching to complete

The patched file will be saved as:
```
/sdcard/Download/magisk_patched-XXXXX_XXXXX.img
```

(The exact filename includes a random suffix.)

---

## Step 7: Pull the patched image to PC

```bash
# List the patched file to get exact name
adb shell ls /sdcard/Download/magisk_patched*

# Pull it
adb pull /sdcard/Download/magisk_patched-XXXXX_XXXXX.img magisk_patched.img
```

Replace `XXXXX_XXXXX` with the actual filename shown by the `ls` command.

---

## Step 8: Identify the active boot slot

The POCO C71 uses A/B partitioning. You need to flash to the ACTIVE slot.

```bash
adb shell getprop ro.boot.slot_suffix
```

**Expected output**:
```
_a
```

This means the active slot is **A**, so you flash to `boot_a`.

If it returns `_b`, flash to `boot_b` instead.

---

## Step 9: Reboot to fastboot and flash

```bash
adb reboot bootloader
```

Wait for the device to enter fastboot mode (screen shows "FASTBOOT" or bootloader menu).

```bash
# Verify device is in fastboot
fastboot devices
# Should show: 9b01005930533036340030832250ac    fastboot

# Flash the patched boot image to slot A
fastboot flash boot_a magisk_patched.img
```

**Expected output**:
```
Sending 'boot_a' (XXXXX KB)                      OKAY [  X.XXXs]
Writing 'boot_a'                                  OKAY [  X.XXXs]
Finished. Total time: X.XXXs
```

**IMPORTANT**: Flash to `boot_a` (not just `boot`). Using `boot` without the slot suffix may flash to the wrong partition or fail on A/B devices.

---

## Step 10: Reboot and verify root

```bash
fastboot reboot
```

Wait for the device to boot completely (1-3 minutes for first boot after flash).

### Verify root access

```bash
adb shell su -c id
```

**Expected output**:
```
uid=0(root) gid=0(root) groups=0(root) context=u:r:magisk:s0
```

If you see `uid=0(root)`, root is working.

### Verify Magisk installation

```bash
adb shell su -c "magisk --version"
```

**Expected output**:
```
28.1
```

```bash
adb shell su -c "magisk -V"
```

**Expected output**:
```
28100
```

---

## Step 11: Configure Magisk (Optional but Recommended)

### Enable Zygisk (for DenyList)

1. Open Magisk app
2. Go to Settings
3. Enable **Zygisk**
4. Enable **Enforce DenyList**
5. Reboot

### Configure DenyList for WhatsApp

WhatsApp may detect root and refuse to run or ban the account. Adding WhatsApp to the DenyList hides root from it.

1. Open Magisk app
2. Go to Settings > Configure DenyList
3. Search for and enable:
   - `com.whatsapp` (WhatsApp)
   - `com.whatsapp.w4b` (WhatsApp Business)
4. Reboot

Alternatively via command line:
```bash
adb shell su -c "magisk --denylist add com.whatsapp"
adb shell su -c "magisk --denylist add com.whatsapp.w4b"
```

---

## Troubleshooting

### "adb shell su" shows "permission denied" or "su: not found"

- Magisk may not have been properly installed
- Open Magisk app and check if it shows "Installed" with version number
- If Magisk shows "N/A", the patched boot image was not flashed correctly
- Re-flash: `adb reboot bootloader && fastboot flash boot_a magisk_patched.img && fastboot reboot`

### ADB not authorized after flash

After flashing, ADB authorization may be lost:

```bash
adb kill-server
sudo $(which adb) start-server
adb devices
```

If still unauthorized, check the device screen for the ADB authorization prompt and tap "Allow".

See `06-adb-troubleshooting.md` for detailed ADB fixes.

### Device bootloops after flashing

If the device bootloops (stuck on Xiaomi logo):

1. Enter fastboot: Hold **Volume Down + Power** for 10 seconds
2. Flash the ORIGINAL (unpatched) boot.img:
   ```bash
   fastboot flash boot_a output/boot.img
   fastboot reboot
   ```
3. This restores the device to non-rooted state
4. Re-attempt the Magisk patching process

### Magisk app shows "Requires Additional Setup"

After first boot with rooted image, Magisk may request to complete installation:

1. Open Magisk app
2. Tap "OK" when prompted for additional setup
3. The device will reboot
4. Verify root again after reboot

### SafetyNet / Play Integrity fails

If apps detect root despite DenyList:

1. Install **Play Integrity Fix** Magisk module from: https://github.com/chiteroman/PlayIntegrityFix
2. In Magisk: Modules > Install from storage > select the ZIP
3. Reboot
4. Verify with YASNAC or Play Integrity Checker app

---

## File Locations Summary

| File | Location |
|------|----------|
| Recovery ROM ZIP | `miui_SERENITYGlobal_A15.0.13.0.VGWMIXM_1478ff1e33_15.0.zip` |
| payload.bin | Extracted from ROM ZIP |
| Original boot.img | Extracted from payload.bin via `payload_dumper` |
| Magisk APK | `Magisk-v28.1.apk` (from GitHub releases) |
| Patched boot.img | `/sdcard/Download/magisk_patched-*.img` (on device) |
| Flash target | `boot_a` partition (Slot A) |

---

## References

- Magisk GitHub: https://github.com/topjohnwu/Magisk
- Magisk Documentation: https://topjohnwu.github.io/Magisk/
- payload_dumper: https://github.com/nickel-33/payload_dumper (pip package)
- Xiaomi Firmware Archive: https://xiaomifirmwareupdater.com/
