# Bootloader Unlock -- POCO C71 / Redmi A5 (Serenity)

> **Device**: POCO C71 / Redmi A5, codename "serenity", model 25028PC03G
> **Chipset**: Unisoc UMS9230E (T615/T7250) -- NOT UMS9230
> **Method**: CVE-2022-38694 exploit via spd_dump
> **Platform Required**: Windows (native -- NOT Wine, NOT VM)
> **Time**: ~30 minutes (once you have the right tools)

---

## Prerequisites

### Hardware
- POCO C71 / Redmi A5 device
- USB-A to USB-C cable (data-capable, not charge-only)
- Windows PC (Windows 10 or 11, native installation)

### Software Downloads

1. **CVE-2022-38694 unlock tool (spd_dump)**
   - Repository: https://github.com/TomKing062/CVE-2022-38694_unlock_bootloader
   - Release: Tag `1.72` (or latest)
   - Download: https://github.com/TomKing062/CVE-2022-38694_unlock_bootloader/releases/tag/1.72
   - File needed: `spd_dump.exe` (Windows binary)

2. **FDL Package -- CRITICAL: Use the correct one**
   - **CORRECT**: `ums9230e_Tecno_KL4.zip` (for UMS9230E variant)
   - **WRONG**: `ums9230_universal_unlock_EMMC.zip` (for UMS9230, will NOT work)
   - Download from the same GitHub releases page
   - Extract to a folder (e.g., `C:\cve-unlock\emmc\`)

3. **Spreadtrum USB Driver for Windows**
   - Required for Windows to detect the device in download mode (SPRD mode)
   - Search: "Spreadtrum USB Driver" or "SPD USB Driver"
   - Install before connecting the device

4. **Android Platform Tools (for fastboot)**
   - Download: https://developer.android.com/tools/releases/platform-tools
   - Or install via: `winget install Google.PlatformTools`

---

## CRITICAL: Chipset Identification

The POCO C71 / Redmi A5 (serenity) uses the Unisoc UMS9230E (T615) chipset. This is a DIFFERENT silicon variant from the UMS9230 (T7250). Although the device reports `ro.board.platform=ums9230` in Android properties, the Boot ROM (BROM) expects FDL1/FDL2 binaries compiled for the UMS9230E variant.

### How to verify your chipset variant

```bash
adb shell getprop ro.board.platform
# Returns: ums9230  (misleading -- this is actually UMS9230E)

adb shell getprop ro.hardware
# Returns: serenity

adb shell cat /proc/cpuinfo | grep "CPU part"
# Returns: CPU part : 0xd05  (Cortex-A55, consistent with T615)
```

The key indicator is the device codename "serenity" and the Tecno KL4 FDL package compatibility. The UMS9230E variant uses different RSA keys in its BROM, so the universal UMS9230 unlock files fail with cryptographic errors.

---

## What Failed (Linux Attempts)

Before finding the working method, the following approaches were attempted on Linux and ALL FAILED. This is documented to save future developers hours of wasted effort.

### Attempt 1: unisoc-unlock (Python tool)

```bash
pip install unisoc-unlock
unisoc-unlock --device serenity
```

**Result**: RSA key mismatch. The Python tool uses a key database that does not include the UMS9230E variant. The BROM rejects the handshake.

**Error**: `RSA signature verification failed` or similar cryptographic error during FDL1 download.

### Attempt 2: spd_dump native Linux binary

```bash
# Compiled from source or downloaded prebuilt
./spd_dump --kickto-fastboot
```

**Result**: `BSL_CMD 0x13 not recognized`. The Linux binary sends the correct protocol commands, but the FDL1/FDL2 files from `ums9230_universal_unlock_EMMC.zip` are for the wrong chipset variant. The BROM accepts the USB connection but rejects the firmware payload.

**Error output**:
```
Sending FDL1...
BSL_CMD 0x13: not recognized by BROM
Failed to download FDL1
```

### Attempt 3: Wine + spd_dump.exe

```bash
wine spd_dump.exe --kickto-fastboot
```

**Result**: Wine cannot access USB devices directly. The spd_dump tool requires low-level USB communication (libusb/WinUSB), which Wine does not support.

**Error**: Device not found / USB access denied.

### Attempt 4: Serial mode (/dev/ttyUSB0)

When the device enters download mode, it may appear as `/dev/ttyUSB0` (serial) instead of a USB bulk device. Attempted serial communication:

```bash
screen /dev/ttyUSB0 115200
# Also tried minicom, picocom
```

**Result**: Handshake failure. The serial interface expects a specific Spreadtrum protocol handshake that the standard BROM tools could not complete with UMS9230E-specific parameters.

### Why Linux Failed

The core issue is that the BROM (Boot ROM) on UMS9230E devices has different cryptographic keys and a slightly different protocol variant compared to the standard UMS9230. The Windows `spd_dump.exe` binary, combined with the correct `ums9230e_Tecno_KL4.zip` FDL files, handles this correctly. No Linux-native solution was found as of 2026-04-06.

---

## Working Method: Windows + spd_dump.exe

### Step 1: Install Spreadtrum USB Driver

1. Download the Spreadtrum / Unisoc USB driver for Windows
2. Run the installer as Administrator
3. Verify installation in Device Manager (no yellow exclamation marks under "Ports" or "USB")

### Step 2: Prepare the unlock files

1. Download `spd_dump.exe` from TomKing062 release 1.72
2. Download `ums9230e_Tecno_KL4.zip`
3. Extract the ZIP to a folder, e.g., `C:\cve-unlock\emmc\`
4. The folder should contain approximately 11 files including FDL1, FDL2, and partition images

Expected contents of the extracted folder:
```
C:\cve-unlock\emmc\
├── fdl1-dl.bin         (First stage bootloader for download mode)
├── fdl2-dl.bin         (Second stage bootloader for download mode)
├── u-boot.bin          (U-Boot bootloader)
├── u-boot-dtb.bin      (U-Boot with device tree)
├── ... (other partition images)
└── unlock.bin          (Unlock payload)
```

### Step 3: Enter Download Mode (SPRD Mode)

1. Power off the device completely
2. Press and hold **Volume Down**
3. While holding Volume Down, connect the USB cable to the PC
4. Hold Volume Down for ~5 seconds after connecting
5. The screen should remain BLACK (no Xiaomi logo) -- this means the device is in BROM/download mode
6. Windows should detect a new USB device (check Device Manager)

If the device boots normally (shows Xiaomi logo), you missed the timing. Disconnect, power off, and try again.

### Step 4: Run the exploit

Open Command Prompt (or PowerShell) as Administrator and navigate to the spd_dump directory:

```cmd
cd C:\cve-unlock

spd_dump.exe --kickto-fastboot emmc\fdl1-dl.bin emmc\fdl2-dl.bin
```

**Expected output**:
```
Connecting to device...
Device found: Spreadtrum UMS9230E
Sending FDL1... OK
Sending FDL2... OK
Executing exploit...
Rebooting to fastboot...
Done
```

The device will reboot into fastboot mode. The screen may show "FASTBOOT" text or remain on the bootloader screen.

### Step 5: Unlock the bootloader

Once in fastboot mode:

```cmd
fastboot oem unlock
```

**Expected output**:
```
OKAY [  0.500s]
Finished. Total time: 0.500s
```

**WARNING**: This performs a factory reset. All data on the device will be erased.

### Step 6: Confirm unlock and reboot

```cmd
fastboot getvar unlocked
```

**Expected output**:
```
unlocked: yes
Finished. Total time: 0.000s
```

If the output shows `unlocked: yes`, the bootloader is successfully unlocked.

```cmd
fastboot reboot
```

The device will reboot and go through initial setup (factory reset state).

---

## Post-Unlock Verification

After the device boots into Android and you complete initial setup:

```bash
# From your Linux/Mac development machine
adb devices
# Should show: 9b01005930533036340030832250ac    device

adb shell getprop ro.boot.verifiedbootstate
# Should show: orange  (unlocked bootloader)

fastboot getvar unlocked
# Should show: unlocked: yes
```

**Note**: After factory reset, you will need to re-authorize ADB. See `06-adb-troubleshooting.md`.

---

## Troubleshooting

### Device not detected in download mode
- Verify the Spreadtrum USB driver is installed
- Try a different USB port (USB 2.0 ports often work better than USB 3.0)
- Try a different USB cable
- Make sure the device is fully powered off before entering download mode

### spd_dump reports "device not found"
- Run Command Prompt as Administrator
- Check Device Manager for the Spreadtrum device
- Reinstall the USB driver

### BSL_CMD errors
- You are using the WRONG FDL files
- Verify you are using `ums9230e_Tecno_KL4.zip`, NOT `ums9230_universal_unlock_EMMC.zip`

### fastboot oem unlock fails
- Some firmware versions require `fastboot flashing unlock` instead
- Try both commands

### Device bootloops after unlock
- This is expected on first boot after unlock + factory reset
- Wait up to 10 minutes for the first boot to complete
- If it persists, enter fastboot mode (Volume Down + Power) and flash stock firmware

---

## References

- CVE-2022-38694: https://github.com/TomKing062/CVE-2022-38694_unlock_bootloader
- Unisoc/Spreadtrum security advisory: https://www.unisoc.com/en_us/secy/announcementDetail/1654280989683175426
- XDA Developers forum thread for POCO C71 bootloader unlock
