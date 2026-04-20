# ADB and USB Troubleshooting Guide

> **Device**: POCO C71 / Redmi A5, codename "serenity"
> **Host OS**: Fedora Linux (also applicable to Ubuntu/Debian)
> **ADB Version**: Android Platform Tools (latest)

---

## Issue 1: ADB Not Authorized After Factory Reset or Flash

### Symptom

```bash
adb devices
# Output:
# 9b01005930533036340030832250ac    unauthorized
```

The device shows as `unauthorized` instead of `device`.

### Root Cause

Factory reset (which happens during bootloader unlock) clears the ADB RSA key authorization stored on the device. The device no longer trusts the host PC's ADB key.

Additionally, if the ADB server was started by a different user (e.g., root vs your user), the key negotiation may fail silently.

### Fix

```bash
# Kill the current ADB server
adb kill-server

# Restart ADB server as root (required for USB device access on some Linux setups)
sudo $(which adb) start-server

# Check devices again
adb devices
```

After running these commands:
1. Check the device screen -- an **"Allow USB debugging?"** dialog should appear
2. Check **"Always allow from this computer"**
3. Tap **"Allow"**

```bash
# Verify
adb devices
# Expected:
# 9b01005930533036340030832250ac    device
```

### If the dialog does NOT appear

1. Disconnect and reconnect the USB cable
2. Toggle USB debugging OFF and ON in Developer Options
3. Revoke USB debugging authorizations:
   - Settings > Developer Options > Revoke USB debugging authorizations
   - Reconnect and re-authorize

### If still unauthorized

Delete the ADB key on the host and regenerate:

```bash
# Remove old keys
rm ~/.android/adbkey
rm ~/.android/adbkey.pub

# Restart server (will generate new keys)
adb kill-server
sudo $(which adb) start-server

# The device will prompt for authorization again
adb devices
```

---

## Issue 2: Device Not Detected at All

### Symptom

```bash
adb devices
# Output: (empty list)
```

No device appears, even though it is physically connected.

### Check 1: USB Cable

- Use a data-capable USB cable (not charge-only)
- Try a different cable
- Try a different USB port (USB 2.0 ports are more reliable for ADB)

### Check 2: USB Mode on Device

The device must be in **MTP (File Transfer)** or **PTP** mode, NOT in charging-only mode.

When you connect the USB cable, a notification appears on the device:
- **"Dispositivo conectado"** (Device connected) -- this is CORRECT for ADB
- **"Este dispositivo"** (This device) or **"Carregando"** (Charging) -- this may NOT expose ADB

Pull down the notification shade and tap the USB notification to change the mode to **File Transfer (MTP)**.

### Check 3: Developer Options and USB Debugging

1. Settings > About Phone > tap "Build number" 7 times to enable Developer Options
2. Settings > Developer Options > Enable **USB debugging**
3. For root operations, also enable **Rooted debugging** (if available)

### Check 4: udev Rules (Linux)

Linux requires udev rules to grant non-root access to USB devices. Create or update the rules file:

```bash
sudo tee /etc/udev/rules.d/51-android.rules << 'EOF'
# Xiaomi / POCO
SUBSYSTEM=="usb", ATTR{idVendor}=="2717", MODE="0666", GROUP="plugdev"

# Google (for fastboot/recovery)
SUBSYSTEM=="usb", ATTR{idVendor}=="18d1", MODE="0666", GROUP="plugdev"

# Unisoc / Spreadtrum (for download mode)
SUBSYSTEM=="usb", ATTR{idVendor}=="1782", MODE="0666", GROUP="plugdev"

# Generic Android ADB
SUBSYSTEM=="usb", ATTR{idVendor}=="04e8", MODE="0666", GROUP="plugdev"
SUBSYSTEM=="usb", ATTR{idVendor}=="0bb4", MODE="0666", GROUP="plugdev"
SUBSYSTEM=="usb", ATTR{idVendor}=="0e8d", MODE="0666", GROUP="plugdev"
SUBSYSTEM=="usb", ATTR{idVendor}=="22b8", MODE="0666", GROUP="plugdev"
EOF

# Reload rules
sudo udevadm control --reload-rules
sudo udevadm trigger

# Add your user to plugdev group
sudo usermod -aG plugdev $USER
```

After creating the rules, disconnect and reconnect the device.

### Check 5: Verify USB device is detected by the kernel

```bash
lsusb | grep -i "xiaomi\|poco\|qualcomm\|unisoc\|spreadtrum\|google"
```

If nothing appears, the issue is at the hardware/driver level (bad cable, bad port, device not in correct mode).

```bash
# Check dmesg for USB events
dmesg | tail -20
```

Look for lines like:
```
usb 1-1: new high-speed USB device number 5 using xhci_hcd
usb 1-1: New USB device found, idVendor=2717, idProduct=ff48
```

---

## Issue 3: USB Tethering Breaks ADB

### Symptom

ADB was working, then stopped after enabling USB tethering (sharing the phone's internet via USB).

### Root Cause

Enabling USB tethering changes the USB mode from MTP/ADB to **RNDIS** (network adapter). The ADB interface is replaced by a network interface.

### Fix

1. Disable USB tethering on the device: Settings > Hotspot > USB tethering > OFF
2. Alternatively, pull down the notification shade and change USB mode back to "File Transfer"
3. Restart ADB server:

```bash
adb kill-server
sudo $(which adb) start-server
adb devices
```

### Prevention

For internet connectivity on the device, use WiFi instead of USB tethering. This keeps the USB interface available for ADB.

---

## Issue 4: Multiple Devices / Targeting a Specific Device

### Symptom

```bash
adb devices
# Output:
# 9b01005930533036340030832250ac    device
# 9b0100593053303634003083239bac    device

adb shell ...
# Error: more than one device/emulator
```

### Fix: Use -s flag with serial number

```bash
# Target Device 1
adb -s 9b01005930533036340030832250ac shell pm list users

# Target Device 2
adb -s 9b0100593053303634003083239bac shell pm list users
```

### Set default device via environment variable

```bash
export ANDROID_SERIAL=9b01005930533036340030832250ac
adb shell pm list users  # Now targets Device 1 without -s
```

---

## Issue 5: ADB Server Port Conflict

### Symptom

```
adb server version (XX) doesn't match this client (YY); killing...
* daemon started successfully *
cannot connect to daemon at tcp:5037
```

### Fix

```bash
# Kill all ADB processes
sudo killall adb 2>/dev/null
adb kill-server

# Verify port 5037 is free
ss -tlnp | grep 5037

# If something is using port 5037, kill it
sudo fuser -k 5037/tcp

# Start fresh
sudo $(which adb) start-server
```

---

## Issue 6: "Permission denied" for Root Commands

### Symptom

```bash
adb shell su -c "id"
# Error: Permission denied
# Or: su: not found
```

### Causes and Fixes

**Cause 1: Magisk not installed**
- Open Magisk app on the device
- Verify it shows "Installed" with version number
- If not, re-flash the patched boot image (see `02-root-magisk.md`)

**Cause 2: Magisk shell access denied**
- Open Magisk app > Settings > Superuser section
- Enable **"Superuser Access"** (should be "Apps and ADB")
- Check the Superuser tab for the shell/ADB entry and grant access

**Cause 3: ADB not running as expected UID**
```bash
# Check ADB shell UID
adb shell id
# Should show: uid=2000(shell) gid=2000(shell)

# Then escalate to root
adb shell su -c id
# Should show: uid=0(root) gid=0(root)
```

---

## Issue 7: Device Offline After Sleep/Disconnect

### Symptom

```bash
adb devices
# Output:
# 9b01005930533036340030832250ac    offline
```

### Fix

```bash
# Simple fix: kill and restart
adb kill-server
sudo $(which adb) start-server
adb devices

# If still offline, physically disconnect and reconnect USB
# Then:
adb devices
```

### Prevention

To prevent the device from going offline due to sleep:

```bash
# Keep screen on while charging
adb shell settings put global stay_on_while_plugged_in 7

# Disable USB suspend
adb shell su -c "echo on > /sys/bus/usb/devices/*/power/control" 2>/dev/null
```

---

## Issue 8: Slow ADB Commands / Timeouts

### Symptom

ADB commands take 10+ seconds or timeout entirely.

### Causes

1. **USB 3.0 compatibility**: Some USB 3.0 ports have issues with Android devices. Try a USB 2.0 port.
2. **Bad cable**: Data cables vary in quality. Use a short, high-quality cable.
3. **Device under load**: If the device is running many users/apps, ADB can be slow. Check: `adb shell dumpsys meminfo | head -5`
4. **ADB over WiFi**: If using `adb connect`, the connection may be slow. Use USB instead for automation.

---

## Quick Reference: Common ADB Commands for Dispatch

```bash
# Device identity
adb shell getprop ro.serialno
adb shell getprop ro.product.model
adb shell getprop ro.build.display.id

# User management
adb shell pm list users
adb shell am get-current-user
adb shell am switch-user <UID>
adb shell am start-user <UID>

# Package management
adb shell pm list packages --user <UID>
adb shell pm install-existing --user <UID> <PKG>
adb shell pm uninstall -k --user <UID> <PKG>

# Root commands
adb shell su -c "id"
adb shell su -c "setprop fw.max_users 8"
adb shell su -c "locksettings clear --user <UID>"

# Screen control
adb shell input keyevent KEYCODE_WAKEUP        # Wake screen
adb shell input keyevent KEYCODE_MENU           # Unlock if swipe
adb shell dumpsys power | grep "mWakefulness"   # Check if awake

# Screenshot
adb shell screencap -p /sdcard/screenshot.png
adb pull /sdcard/screenshot.png ./screenshot.png

# Process monitoring
adb shell ps -A | grep whatsapp
adb shell dumpsys meminfo com.whatsapp
```

---

## Device Serial Reference

| Device | Serial | Notes |
|--------|--------|-------|
| POCO Serenity #1 | `9b01005930533036340030832250ac` | Primary dev device |
| POCO Serenity #2 | `9b0100593053303634003083239bac` | Secondary device |
