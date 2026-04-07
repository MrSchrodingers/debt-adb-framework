# Multi-User Setup -- 8 Android Profiles per Device

> **Prerequisite**: Root via Magisk (see `02-root-magisk.md`)
> **Device**: POCO C71 / Redmi A5, codename "serenity"
> **Android**: 15 (API 35)
> **Default Max Users**: 4 (Android default for this device)
> **Target Max Users**: 8
> **Time**: ~15 minutes

---

## Overview

Android supports multiple user profiles on a single device. Each profile is a completely isolated environment with its own apps, data, and accounts. For the Dispatch framework, each profile runs its own WhatsApp and WhatsApp Business instances with different phone numbers.

### User Types

| Type | How Created | Behavior |
|------|-------------|----------|
| **Owner (User 0)** | Built-in | Always running. Cannot be removed. |
| **Secondary User** | `pm create-user "Name"` | Independent profile. Must `am switch-user` to interact. Sequential only. |
| **Work Profile** | `pm create-user --profileOf 0 --managed "Name"` | Runs IN PARALLEL with its parent user. Apps share the launcher. |

### Key Discovery: Work Profiles Run in Parallel

This is the most important finding from the setup process. A Work Profile (managed profile) is NOT the same as a secondary user:

- **Secondary users** require `am switch-user` and only ONE user's UI is active at a time
- **Work Profiles** run alongside their parent user -- both user 0 AND user 13 (work profile) can have active WhatsApp processes simultaneously
- This means **4 WhatsApp processes can run at the same time**: User 0 WA + User 0 WABA + User 13 WA + User 13 WABA

---

## Step 1: Increase the Maximum User Limit

By default, the POCO C71 allows only 4 users. We need 8.

```bash
adb shell su -c "setprop fw.max_users 8"
```

**Verify**:
```bash
adb shell getprop fw.max_users
```

**Expected output**:
```
8
```

**IMPORTANT**: This property is volatile -- it resets on reboot. To make it persistent, you need to add it to a boot script or Magisk module.

### Make persistent via Magisk post-fs-data script

```bash
adb shell su -c "mkdir -p /data/adb/post-fs-data.d"
adb shell su -c "echo 'resetprop fw.max_users 8' > /data/adb/post-fs-data.d/max_users.sh"
adb shell su -c "chmod 755 /data/adb/post-fs-data.d/max_users.sh"
```

This script runs on every boot before Android finishes starting, ensuring the property is set before the UserManager checks it.

**Verify after reboot**:
```bash
adb reboot
# Wait for boot...
adb shell getprop fw.max_users
# Should show: 8
```

---

## Step 2: Create Secondary Users

Create the standard secondary users (sequential rotation):

```bash
# User names follow the Oralsin naming convention
adb shell pm create-user "Oralsin 2 1"
# Output: Success: created user id 10

adb shell pm create-user "Oralsin 2 2"
# Output: Success: created user id 11

adb shell pm create-user "Oralsin 2 3"
# Output: Success: created user id 12
```

The system assigns user IDs automatically. Typical IDs: 10, 11, 12, etc. (IDs 1-9 are reserved).

---

## Step 3: Create a Work Profile (Parallel Execution)

This is the key to parallelization. The `--profileOf 0` flag creates a managed profile that runs alongside user 0.

```bash
adb shell pm create-user --profileOf 0 --managed "Work"
# Output: Success: created user id 13
```

User 13 is now a Work Profile of User 0. It will run IN PARALLEL with User 0.

---

## Step 4: Create Remaining Users (if needed)

```bash
adb shell pm create-user "Profile 5"
# Output: Success: created user id 14

adb shell pm create-user "Profile 6"
# Output: Success: created user id 15

adb shell pm create-user "Profile 7"
# Output: Success: created user id 16
```

---

## Step 5: Start All Users

Secondary users must be started before they can receive app installations or run apps.

```bash
# Start all secondary users
adb shell am start-user 10
adb shell am start-user 11
adb shell am start-user 12
adb shell am start-user 13
adb shell am start-user 14
adb shell am start-user 15
adb shell am start-user 16
```

**Expected output** for each:
```
Success: user started
```

**Verify all users are running**:
```bash
adb shell pm list users
```

**Expected output**:
```
Users:
	UserInfo{0:Main Oralsin 2:4c13} running
	UserInfo{10:Oralsin 2 1:410} running
	UserInfo{11:Oralsin 2 2:410} running
	UserInfo{12:Oralsin 2 3:410} running
	UserInfo{13:Work:1030} running
	UserInfo{14:Profile 5:410} running
	UserInfo{15:Profile 6:410} running
	UserInfo{16:Profile 7:410} running
```

The flags in the `UserInfo` line indicate the user type:
- `4c13` = Owner (ADMIN + MAIN)
- `410` = Secondary user
- `1030` = Managed profile (Work Profile)

---

## Step 6: Install WhatsApp on All Profiles

WhatsApp must be installed on User 0 first (owner), then made available to other users.

### Install on Owner (User 0)

If WhatsApp is already installed on User 0, skip this step. Otherwise:

```bash
# Download APK or install from Play Store on User 0
adb install com.whatsapp.apk
adb install com.whatsapp.w4b.apk  # WhatsApp Business
```

### Install on Secondary Users

Use `pm install-existing` to make the already-installed package available to other users. This does NOT copy the APK -- it creates a new data directory for the user.

```bash
# Install WhatsApp for all users
for USER_ID in 10 11 12 13 14 15 16; do
  adb shell pm install-existing --user $USER_ID com.whatsapp
  adb shell pm install-existing --user $USER_ID com.whatsapp.w4b
done
```

**Expected output** for each:
```
Package com.whatsapp installed for user: 10
Package com.whatsapp.w4b installed for user: 10
```

### Verify installation

```bash
# Check WhatsApp is installed for all users
for USER_ID in 0 10 11 12 13 14 15 16; do
  echo "User $USER_ID:"
  adb shell pm list packages --user $USER_ID | grep whatsapp
done
```

**Expected output** for each user:
```
User 0:
package:com.whatsapp
package:com.whatsapp.w4b
User 10:
package:com.whatsapp
package:com.whatsapp.w4b
...
```

---

## Step 7: Configure WhatsApp on Each Profile

Each profile needs WhatsApp configured with a different phone number. This must be done manually:

### For Secondary Users (10, 11, 12, 14, 15, 16)

```bash
# Switch to the user
adb shell am switch-user <USER_ID>

# Wait for the profile to load (3-8 seconds)
# Unlock if needed (PIN: 12345)
# Open WhatsApp manually and complete phone number verification via SMS
```

**Important**: The device needs a SIM card or SMS forwarding service for 2FA verification. See `04-hygienization.md` for SMS provider restoration.

### For Work Profile (User 13)

The Work Profile appears in the same launcher as User 0 (with a briefcase badge on app icons). No user switching needed:

1. Look for the briefcase-badged WhatsApp icon in the app drawer
2. Tap it to open Work Profile WhatsApp
3. Complete phone number verification

---

## Step 8: Verify Parallel Execution

This step confirms that the Work Profile runs in parallel with the main user.

```bash
# Check running WhatsApp processes
adb shell ps -A | grep whatsapp
```

**Expected output** (when User 0 is foreground):
```
u0_a123  12345 ... com.whatsapp
u0_a124  12346 ... com.whatsapp.w4b
u13_a123 12347 ... com.whatsapp
u13_a124 12348 ... com.whatsapp.w4b
```

Four WhatsApp processes running simultaneously:
- `u0_a123` = User 0, WhatsApp
- `u0_a124` = User 0, WhatsApp Business
- `u13_a123` = User 13 (Work Profile), WhatsApp
- `u13_a124` = User 13 (Work Profile), WhatsApp Business

For secondary users (10, 11, 12, etc.), their WhatsApp processes will only appear when that user is the foreground user (after `am switch-user`).

---

## User Management Commands Reference

### List all users
```bash
adb shell pm list users
```

### Switch to a user (brings their UI to foreground)
```bash
adb shell am switch-user <USER_ID>
```

### Start a user (keeps running in background)
```bash
adb shell am start-user <USER_ID>
```

### Stop a user (frees memory)
```bash
adb shell am stop-user <USER_ID>
```

### Remove a user (deletes all data)
```bash
adb shell pm remove-user <USER_ID>
```

### Get current foreground user
```bash
adb shell am get-current-user
```

### List packages for a specific user
```bash
adb shell pm list packages --user <USER_ID>
```

### Install existing package for a user
```bash
adb shell pm install-existing --user <USER_ID> <PACKAGE_NAME>
```

### Uninstall package for a specific user (keeps for others)
```bash
adb shell pm uninstall -k --user <USER_ID> <PACKAGE_NAME>
```

---

## Auto-Start Users on Boot

By default, only User 0 starts on boot. Secondary users must be started manually. To auto-start them, create a Magisk boot script:

```bash
adb shell su -c "cat > /data/adb/service.d/start_users.sh << 'SCRIPT'
#!/system/bin/sh
# Wait for system to be ready
sleep 30

# Start all secondary users
for UID in 10 11 12 13 14 15 16; do
  am start-user $UID
done
SCRIPT"

adb shell su -c "chmod 755 /data/adb/service.d/start_users.sh"
```

The `service.d` scripts run after the system boots (vs `post-fs-data.d` which runs before).

---

## Profile to WhatsApp Number Mapping (Device 1)

| User ID | Profile Name | WhatsApp Number | WA Business Number |
|---------|-------------|-----------------|-------------------|
| 0 | Main Oralsin 2 | +55 43 9683-5100 | (not configured) |
| 10 | Oralsin 2 1 | +55 43 9683-5095 | (not configured) |
| 11 | Oralsin 2 2 | +55 43 9683-7813 | (not configured) |
| 12 | Oralsin 2 3 | +55 43 9683-7844 | (not configured) |
| 13 | Work | (pending) | (pending) |
| 14 | Profile 5 | (pending) | (pending) |
| 15 | Profile 6 | (pending) | (pending) |
| 16 | Profile 7 | (pending) | (pending) |

---

## Troubleshooting

### "Error: couldn't create User" when creating users
- Check current user count: `adb shell pm list users | wc -l`
- Check max users: `adb shell getprop fw.max_users`
- If max is too low, increase it (Step 1)

### Work Profile apps don't appear in launcher
- The launcher may need to be restarted: `adb shell am force-stop com.miui.home`
- Or reboot the device

### "User is not running" when installing packages
- Start the user first: `adb shell am start-user <USER_ID>`
- Wait 5 seconds, then retry

### WhatsApp crashes on secondary users
- Ensure the user has Google Play Services available
- Run: `adb shell pm install-existing --user <USER_ID> com.google.android.gms`

### Memory pressure kills background users
- The POCO C71 has ~2.8 GB RAM, which is tight for 8 users
- Reduce running users to only those actively needed
- Monitor with: `adb shell dumpsys meminfo | grep "Total RAM"`
- Consider keeping only 4 users running simultaneously
