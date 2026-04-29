# POCO C71 Root Procedure (POCO #1 reference build)

Reproduces the rooted reference build on a fresh POCO C71 (codename
**serenity**, Unisoc T603 SoC). Same procedure applies to the closest
variants that ship the T603: **Redmi A5**, and most **Tecno Spark Go (T603)**
SKUs.

> Outcome: `adb shell su -c id` returns `uid=0`, Magisk app reports
> v28.1+, **PlayIntegrityFork v16** and **Zygisk-Assistant v2.1.4** are
> active in the Modules tab, DenyList includes `com.whatsapp`,
> `com.whatsapp.w4b`, and `com.google.android.gms`, and SafetyNet
> passes (BASIC + CTS + STRONG when EVAL/HARDWARE keybox is present).

This document is the source of truth referenced by:

- `scripts/bootstrap-poco-device.sh` (CLI bootstrap)
- `packages/ui/src/components/device-setup-wizard.tsx` (UI wizard)
- `docs/superpowers/plans/2026-04-29-research-track-frida-redroid.md`
  (background on why root is mandatory for multi-user parallelization)

## 0. Hardware prerequisites

| Item | Spec |
|---|---|
| Device | POCO C71 (serenity) or Redmi A5 (T603) |
| SoC | Unisoc T603 (SC9863A1) |
| Slot/USB | OEM-quality USB-C cable (no flaky cheap units) |
| Workstation | Linux + `adb`, `fastboot` available |
| Network | Xiaomi account with at least 1 week of activity |

## 1. Bootloader unlock (Mi Unlock Tool)

1. Create a Xiaomi account, set a phone number, sign in on the device,
   wait at least 7 days. Some firmwares enforce 168 h.
2. On the device: **Settings -> About phone -> tap MIUI version 7x** to
   unlock developer options.
3. Developer options:
   - **OEM unlocking**: ON
   - **USB debugging**: ON
   - **Mi Unlock status**: bind your account.
4. Boot the device into fastboot:
   ```bash
   adb reboot bootloader
   ```
5. Run **Mi Unlock Tool** on Windows (only Windows-supported). Click
   "Unlock". The first attempt usually fails with **"Couldn't verify
   device. Try again later"**. The tool tells you the cooldown (3-15
   days). Wait it out, do not switch accounts.
6. After unlock, fastboot reports `Unlocked` on boot for 5 s. Re-enable
   USB debugging from scratch.

## 2. Extract official boot.img

Download the matching firmware ROM (HyperOS / MIUI Recovery flash zip
for serenity) and extract `boot.img` from the OTA payload:

```bash
# Install payload-dumper-go once
go install github.com/ssut/payload-dumper-go@latest

# Inside the firmware zip, payload.bin is the relevant file
unzip -p miui_serenity_*.zip payload.bin > payload.bin
payload-dumper-go -p boot payload.bin   # writes boot.img to ./extracted/
```

## 3. Patch boot.img with Magisk

1. Sideload the Magisk APK (28.1 or newer, 32-bit ARM build):
   ```bash
   curl -L -o /tmp/Magisk-v28.1.apk \
     https://github.com/topjohnwu/Magisk/releases/download/v28.1/Magisk-v28.1.apk
   adb push /tmp/Magisk-v28.1.apk /sdcard/
   adb install /tmp/Magisk-v28.1.apk
   ```
2. Push the stock `boot.img` to the device:
   ```bash
   adb push extracted/boot.img /sdcard/boot.img
   ```
3. Open the **Magisk** app on the device:
   - **Install** -> **Select and Patch a File** -> pick
     `/sdcard/boot.img`.
   - Magisk writes `magisk_patched-XXXXX.img` to `/sdcard/Download/`.
4. Pull the patched image back to the workstation:
   ```bash
   adb pull /sdcard/Download/magisk_patched-*.img /tmp/magisk_patched.img
   ```

## 4. Flash patched boot

```bash
adb reboot bootloader
fastboot flash boot /tmp/magisk_patched.img
fastboot reboot
```

The first boot is slower than usual (Magisk initial setup, ~90 s).

## 5. Validate root

After the device boots and you complete the Setup Wizard for user 0:

```bash
adb shell su -c id
# Expected:  uid=0(root) gid=0(root) groups=0(root)...

adb shell magisk -V
# Expected:  28100 (or higher)
```

The first `su` invocation triggers a Magisk dialog on-device asking the
operator to grant ADB root. Tap **Grant**. The choice is remembered.

## 6. Stealth modules (Magisk Modules tab)

Install both modules from the Magisk app -> **Modules** -> **Install
from storage**. Reboot once after each.

### 6.1 PlayIntegrityFork v16

| Field | Value |
|---|---|
| Module | `osm0sis & chiteroman / PlayIntegrityFork` |
| Version | v16 (or later) |
| Source | https://github.com/osm0sis/PlayIntegrityFork/releases |
| File | `PlayIntegrityFork_v16.zip` |

Provides a forged response to Play Integrity API calls. Required so
Google services and WhatsApp do not flag the device as tampered.

### 6.2 Zygisk-Assistant v2.1.4

| Field | Value |
|---|---|
| Module | `snake-4 / zygisk-assistant` (fork) |
| Version | v2.1.4 |
| Source | https://github.com/snake-4/zygisk-assistant/releases |
| File | `zygisk-assistant-v2.1.4.zip` |

Re-implements MagiskHide-style mount namespace cleaning post-Zygisk.
Without it, several apps (Banking, WhatsApp anti-fraud) detect Magisk
and refuse to log in.

### 6.3 Enable Zygisk + DenyList

In the Magisk app -> **Settings**:

- **Zygisk**: ON (requires reboot)
- **Enforce DenyList**: ON

Then **Settings -> Configure DenyList** and tick:

- `com.whatsapp`
- `com.whatsapp.w4b`
- `com.google.android.gms`
- (recommended) `com.google.android.gsf`

## 7. Post-install validation

```bash
# Magisk version
adb shell magisk -V

# Modules active
adb shell su -c 'magisk --list | grep -E "playintegrity|zygisk|assistant"'

# DenyList status
adb shell su -c 'magisk --denylist status'

# DenyList contents
adb shell su -c 'magisk --denylist ls' | grep -E "whatsapp|gms"
```

Open **YASNAC** (Yet Another SafetyNet Attestation Checker) on the
device -> **Run test**. Expect **BASIC + CTS** at minimum; if a
HARDWARE keybox is mounted, **STRONG** also passes. WhatsApp will not
notice anything; Google Pay still flags STRONG-required transactions if
the keybox is software-only.

## 8. Recovery: bootloop / module breaks boot

Magisk has a built-in safe mode that disables every module on the next
boot:

1. Power the device fully off.
2. Hold **Volume Down + Power** until the Mi logo appears.
3. Release Power, keep Volume Down held until Recovery / fastboot menu
   shows. From there, simply select **Reboot to system**. Magisk
   detects the abnormal boot path and starts in safe mode.
4. Once back in OS: open Magisk app -> **Modules** -> remove the
   offender, reboot.

Worst case: re-flash the unpatched stock `boot.img` from step 2:

```bash
fastboot flash boot extracted/boot.img
fastboot reboot
```

## 9. Common pitfalls

- **WhatsApp logs out repeatedly**: DenyList not enabled or Zygisk off.
  Re-check both, reboot.
- **Magisk app reports "no ramdisk"**: you flashed an A/B firmware boot
  to an A-only slot or vice versa. Use the matching `boot.img` for
  exactly your firmware version.
- **`su -c id` returns nothing**: the on-device Magisk superuser dialog
  was missed and timed out as DENY. Run `adb shell` interactively, type
  `su`, accept on the device, then exit and retry.
- **Mi Unlock Tool refuses indefinitely**: account binding lapses if
  you switch SIMs in the bootloader-locked state. Re-bind from the
  device after each unlock attempt.

## 10. Cross-references

- `scripts/bootstrap-poco-device.sh` -- CLI HITL bootstrap.
- `packages/ui/src/components/device-setup-wizard.tsx` -- UI wizard
  (Step 1 calls `POST /api/v1/devices/:serial/setup/root-check`, which
  runs `su -c id` and persists the outcome in
  `device_setup_wizard_state`).
- `docs/devices/multi-user-fleet-setup.md` -- next stage: secondary
  users, setup-wizard bypass, WhatsApp install per profile.
