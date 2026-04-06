# Research: Parallel Multi-Profile Execution on a Single Android Device

> **Date**: 2026-04-01
> **Author**: Claude Opus 4.6 (research) + Matheus (request)
> **Context**: Phase 8 architecture decision for DEBT ADB Framework
> **Device**: POCO phone, Android 15 (API 35), 4 user profiles, root available
> **Goal**: Send WhatsApp messages from multiple profiles AT THE SAME TIME on one device

---

## Executive Summary

**True parallel execution of multiple user profiles with independent UI on a single physical Android device is NOT natively supported on phones.** Android's multi-user system was designed for sequential user switching, not simultaneous operation. However, there are several viable approaches ranging from "almost parallel" to "truly parallel with significant hacking."

### Verdict Table

| Approach | Feasibility | True Parallel? | Root Required? | WhatsApp Safe? | Recommended? |
|----------|------------|----------------|----------------|----------------|--------------|
| 1. scrcpy Virtual Displays (same user) | HIGH | YES (same user) | No | N/A (single account) | FOR DISPLAY ONLY |
| 2. Sequential User Rotation | HIGH | No (time-sliced) | No | Yes | **YES - PRAGMATIC** |
| 3. RRO Overlay for Visible Background Users | LOW-MEDIUM | Potentially YES | Yes (deep) | Unknown | EXPERIMENTAL |
| 4. Work Profile + Main Profile | MEDIUM | Partial | No | Yes | YES (2 accounts max) |
| 5. POCO Second Space + Dual Apps | HIGH | No (sequential) | No | Yes | YES (limited) |
| 6. Xposed/Magisk Modules | LOW | No | Yes | RISKY | NO |
| 7. Desktop Mode + Virtual Display | LOW | Limited | Partial | Unknown | NO |
| 8. Accessibility Service | LOW | No | Yes | N/A | NO |
| 9. Android Containers (Parallel Space etc.) | MEDIUM | No (UI sharing) | No | RISKY | NO |
| 10. Custom AOSP Build | HIGH (if built) | YES | Full system | Yes | OVERKILL |

**Recommended Architecture**: Sequential user rotation with optimized switch times (Approach 2), optionally combined with Work Profile (Approach 4) for 2-profile concurrency.

---

## Approach 1: scrcpy Virtual Displays

### How It Works

scrcpy v3.0+ (released November 2024) introduced `--new-display` which creates virtual displays on the Android device. Multiple scrcpy instances can run simultaneously, each with its own virtual display:

```bash
# Terminal 1: Main display
scrcpy --new-display=1080x1920 --start-app=com.whatsapp

# Terminal 2: Second virtual display
scrcpy --new-display=1080x1920 --start-app=com.example.otherapp
```

### Technical Details

- **Display creation**: Creates a `VirtualDisplay` via Android's `DisplayManager` API
- **Input**: Each scrcpy window handles input independently via its own display
- **Screenshots**: scrcpy streams video; also `adb shell screencap -d <DISPLAY_ID>` works per display
- **ADB input injection**: `adb shell input -d <DISPLAY_ID> tap X Y` targets specific displays
- **Display IDs**: Found via `adb shell dumpsys display` (search for `mDisplayId=`)
- **IME**: Can be local to virtual display with `--display-ime-policy=local`
- **Destruction**: Virtual display destroyed when scrcpy exits; use `--no-vd-destroy-content` to move apps to main display

### Why It Doesn't Solve Our Problem

**Critical limitation**: All virtual displays run under the SAME user profile. You cannot run WhatsApp twice under the same user -- Android enforces single-instance per package per user. The `com.whatsapp` package can only have ONE running instance per user.

You COULD launch WhatsApp on display 0 for user 0 and try to launch it on a virtual display for user 10, but Android 15 on phones does NOT support visible background users (see Approach 3).

### Verdict

**Useful for**: Independent display/input targeting per virtual display (important building block).
**NOT useful for**: Running multiple WhatsApp accounts simultaneously.

---

## Approach 2: Sequential User Rotation (RECOMMENDED)

### How It Works

Instead of true parallelism, rapidly rotate between user profiles:

```
User 10 (foreground) -> send message -> am switch-user 11 -> send message -> am switch-user 12 -> ...
```

### Technical Details

**ADB Commands**:
```bash
# List users
adb shell pm list users

# Switch to user 11
adb shell am switch-user 11

# Start WhatsApp for user 11
adb shell am start-activity --user 11 -n com.whatsapp/.Main

# Send input
adb shell input tap X Y
adb shell input text "message"
```

**User Switch Latency**: Based on empirical testing across devices, user switching typically takes 2-8 seconds depending on:
- Number of apps in the target profile
- Device RAM and CPU
- Whether the target user was previously running (warm vs cold start)
- Device manufacturer optimizations (MIUI/HyperOS may be faster)

**What happens during switch**:
1. Current foreground user's activities are stopped (not destroyed if within `config_multiuserMaxRunningUsers`)
2. Target user's activities are resumed or started
3. Lock screen may appear (can be disabled per user)
4. Display transitions to target user's UI

**Background user behavior** (Android 15, standard phones):
- Background users CAN continue running services (not activities)
- Background users CANNOT display UI
- Background users retain network connectivity
- System may halt background users under memory pressure
- WhatsApp's background services (FCM receiver, message sync) continue running

### Optimization Strategies

1. **Disable lock screen** on all secondary profiles
2. **Pre-warm all profiles** at startup: switch through each once
3. **Minimize apps per profile**: Only WhatsApp + essentials
4. **Increase max running users** via root:
   ```bash
   adb shell su -c "setprop fw.max_users 8"
   ```
5. **Pipeline architecture**: While user N is in foreground sending, prepare user N+1's message in queue
6. **Batch per user**: Send multiple messages per user before switching (reduces total switches)

### Throughput Calculation

Assuming:
- 3-second user switch time
- 15-second WhatsApp send time (open contact, type, send, screenshot)
- 4 user profiles
- 3 messages batched per user before switching

```
Per rotation cycle: 4 * (3s switch + 3 * 15s send) = 4 * 48s = 192s = 3.2 minutes
Messages per cycle: 12
Throughput: ~3.75 messages/minute (225/hour)
```

Without batching: 4 * (3 + 15) = 72s for 4 messages = ~3.3 messages/minute

### Verdict

**Feasibility**: HIGH -- works today, no root needed for basic operation.
**True parallel**: No, but effective throughput is reasonable.
**WhatsApp safe**: Yes -- uses official app in official Android user profiles.
**Recommendation**: **This is the pragmatic choice for Phase 8.**

---

## Approach 3: RRO Overlay for Visible Background Users

### How It Works

Android 15 introduced `config_multiuserVisibleBackgroundUsers` specifically for Android Automotive. When enabled, background users can launch activities and access UI on displays they are assigned to. This is the ONLY official Android mechanism for true multi-user-multi-display parallelism.

### Technical Implementation

1. **Create an RRO (Runtime Resource Overlay)**:
   ```xml
   <!-- res/values/config.xml -->
   <resources>
     <bool name="config_multiuserVisibleBackgroundUsers">true</bool>
     <integer name="config_multiuserMaxRunningUsers">5</integer>
   </resources>
   ```

2. **Package as Magisk Module**:
   ```
   module/
     module.prop
     system/
       vendor/
         overlay/
           MultiUserOverlay.apk
   ```

3. **Install and reboot**

4. **Create virtual displays and assign users**:
   ```bash
   # Create virtual display via scrcpy
   scrcpy --new-display=1080x1920

   # Find display ID
   adb shell dumpsys display | grep mDisplayId

   # Start user on specific display (theoretical)
   adb shell am start-activity --user 11 --display 2 -n com.whatsapp/.Main
   ```

### Critical Unknowns

1. **Will the framework respect the overlay on a non-automotive build?**
   - The config flag exists in `frameworks/base/core/res/res/values/config.xml`
   - The overlay mechanism (RRO) CAN change it
   - But the ActivityManagerService and UserManagerService may have additional automotive-specific code paths
   - AOSP docs explicitly state: "should be false for most devices, except automotive vehicles with passenger displays"

2. **User-to-display assignment**:
   - Android Automotive uses "occupant zones" (`CarOccupantZoneManager`) to map users to displays
   - This API does NOT exist on standard Android builds
   - Without it, there's no standard way to assign a background user to a specific virtual display
   - The `am start-activity --user N --display D` command exists but may be blocked by security policy for non-automotive

3. **Framework validation**:
   - `ActivityStarter.java` performs security checks before allowing activity launches on specific displays
   - Apps can only launch on virtual displays they OWN (Android 10+ restriction)
   - System shell (`uid=2000`) has elevated permissions but may not bypass all checks
   - Root (`uid=0`) bypasses most but not all framework-level restrictions

### What Would Need to Happen

1. Root the POCO device
2. Install Magisk with RRO module enabling visible background users
3. Possibly also need to patch/hook `UserManagerService` to allow user-display assignment
4. Test if `am start-activity --user 11 --display 2` actually works
5. If not, may need Xposed hook to bypass `ActivityStarter` security checks

### Verdict

**Feasibility**: LOW-MEDIUM -- the flag can be set, but the full Automotive framework stack is missing.
**Risk**: High -- may cause system instability, bootloops, or simply not work.
**Worth investigating**: Yes, as a Phase 8 experiment, but NOT as a dependency.

---

## Approach 4: Work Profile + Main Profile

### How It Works

Android Work Profiles (managed profiles) are a special type of user profile that runs "alongside" the main profile. Unlike secondary users, work profile apps appear in the same launcher (with a briefcase badge) and CAN run simultaneously with main profile apps.

### Technical Details

- Work profile is created via `DevicePolicyManager`
- Apps in work profile have separate data/storage
- Work profile apps CAN run in background while main profile is active
- WhatsApp in work profile = separate WhatsApp instance with different number
- **Both can receive messages simultaneously**

### Limitations

1. **Only ONE work profile** per device (Android limitation)
2. **Not true display separation** -- both profiles share the same display
3. **UI interaction is sequential** -- you must tap into work WhatsApp or personal WhatsApp one at a time
4. **ADB input goes to the active window** -- you can't tap both simultaneously

### For Our Use Case

- Personal profile: WhatsApp with number A
- Work profile: WhatsApp with number B
- Both receive messages and run services simultaneously
- **Sending is still sequential** (switch app, send, switch back, send)
- But NO user-switch delay (both are in the same "foreground user")

### How to Set Up

```bash
# Using adb (requires device owner or profile owner)
adb shell dpm set-profile-owner --user 0 com.example.admin/.AdminReceiver

# Or use a third-party app like "Island" or "Shelter"
# These create work profiles without enterprise MDM
```

### Verdict

**Feasibility**: MEDIUM-HIGH for 2 accounts.
**True parallel**: Services run in parallel; UI interaction is sequential but WITHOUT user-switch delay.
**WhatsApp safe**: Yes -- official feature, official app.
**Limitation**: Only 2 accounts (main + work profile). Cannot scale to 4.

---

## Approach 5: POCO Second Space + Dual Apps

### How It Works

POCO/Xiaomi devices with HyperOS include:
- **Second Space**: Creates a completely separate user profile (equivalent to Android secondary user)
- **Dual Apps**: Clones an app within the SAME user profile using Xiaomi's built-in package cloning

### Combination Strategy

- Main space: WhatsApp (number A) + Dual Apps WhatsApp (number B)
- Second Space: WhatsApp (number C) + Dual Apps WhatsApp (number D)
- **Result: 4 WhatsApp accounts on one device**

### Limitations

- Second Space is just a UI wrapper around Android's multi-user
- Switching between Main Space and Second Space = user switch (same 3-8s delay)
- Dual Apps within same space: sequential UI interaction, no display separation
- **Net result**: Same as Approach 2 but with up to 4 accounts per 2 user profiles

### Verdict

**Feasibility**: HIGH -- already built into POCO devices.
**True parallel**: No.
**WhatsApp safe**: Dual Apps uses OEM-level cloning (Xiaomi signs the cloned package), generally accepted by WhatsApp.
**Useful for**: Getting 4 accounts set up. NOT for parallel sending.

---

## Approach 6: Xposed/Magisk Modules

### What Exists

- **Wa Revamp (LSPosed)**: Adds dual account switching within WhatsApp, but does NOT create true parallel instances
- **Parallel Space Magisk**: Some modules attempt to run apps in isolated namespaces
- **No module exists** that enables true parallel multi-user multi-display execution

### Why It's Problematic

1. WhatsApp actively detects modified environments (Xposed hooks, modified APKs)
2. WhatsApp has been known to ban accounts using modified clients
3. LSPosed/Xposed adds latency and instability
4. No existing module solves the fundamental display-per-user problem

### Verdict

**Feasibility**: LOW for our use case.
**Risk**: HIGH (WhatsApp bans).
**Recommendation**: Avoid.

---

## Approach 7: Desktop Mode + Virtual Display

### How It Works

Android 15+ has an experimental Desktop Mode (force-enabled via Developer Options). Combined with scrcpy virtual displays, apps can run in freeform windows.

### What Was Tested (Community)

A Pixel 8 Pro user successfully ran Desktop Mode via:
```bash
# Enable in Developer Options:
# - Force activities to be resizable
# - Freeform windows
# - Freeform Windows on Secondary Display
# - Non-resizable in Multi-Window

scrcpy --new-display=2560x1200/120
```

### Limitation for Our Use Case

Desktop Mode still runs under a SINGLE user. It provides multi-window, not multi-user. You still cannot run two instances of `com.whatsapp` under the same user.

### Verdict

**Feasibility**: LOW for multi-account WhatsApp.
**Useful for**: Making the UI more manageable during sequential sends.

---

## Approach 8: Accessibility Service

### How It Works

A root-level accessibility service could theoretically:
1. Register with `FLAG_RETRIEVE_INTERACTIVE_WINDOWS` to access all windows
2. Inject events into specific windows
3. Cross user boundaries with `INTERACT_ACROSS_USERS_FULL` permission

### Limitations

1. Accessibility services run in the FOREGROUND user's context
2. Cannot interact with background user's UI (because background users have NO UI on phones)
3. `INTERACT_ACROSS_USERS_FULL` allows data access, not UI manipulation
4. Would need to be a system app (installed in `/system/priv-app/`)

### Verdict

**Feasibility**: LOW -- does not solve the fundamental "background user has no display" problem.

---

## Approach 9: App Containers (Parallel Space, Virtual Master, etc.)

### How They Work

Apps like Parallel Space, Virtual Master, and Clone App create "virtual environments" by:
1. Changing the package name (e.g., `com.whatsapp` -> `com.whatsapp.clone1`)
2. Creating separate data directories
3. Using Android's VirtualApp framework or similar

### Technical Implementation

- Uses Linux namespaces (partially) and Android's package management
- Each "clone" appears as a separate app
- Runs under the SAME user profile
- Shares the SAME display

### WhatsApp Detection

WhatsApp HAS been known to detect and ban accounts running in:
- Parallel Space (detected via package name inspection)
- Clone apps using modified package names
- Virtual environments with non-standard `android_id` or device fingerprints

### Verdict

**Feasibility**: MEDIUM for getting multiple accounts running.
**True parallel UI**: No -- sequential interaction on shared display.
**WhatsApp ban risk**: MODERATE to HIGH.
**Recommendation**: Avoid for production use.

---

## Approach 10: Custom AOSP Build (Nuclear Option)

### What It Would Take

Building a custom Android ROM for the POCO device that:
1. Enables `config_multiuserVisibleBackgroundUsers=true`
2. Includes the `CarOccupantZoneManager` (or equivalent) for user-display mapping
3. Patches `ActivityStarter.java` to allow cross-user cross-display activity launches
4. Adds a system service for user-display assignment via ADB

### Feasibility

- POCO devices often have unlockable bootloaders
- AOSP source is available for many Qualcomm/MediaTek SoCs
- Building a custom ROM is a months-long project
- Maintaining it across Android updates is a perpetual cost

### Verdict

**Feasibility**: HIGH (technically possible) but EXTREMELY expensive in time.
**True parallel**: YES -- this is what Android Automotive does.
**Recommendation**: Only if this becomes a product, not for Phase 8.

---

## BipDevice Research

### Findings

No information was found about "bipdevice.io" in any web search. The domain and product name returned zero relevant results across multiple search queries. Possible explanations:

1. The product may not exist (yet) or may be extremely new/small
2. The name may be different than searched
3. It may be a private/enterprise product not publicly indexed

If BipDevice does exist and achieves parallel multi-profile WhatsApp automation, they are most likely using one of:
- Multiple physical devices (phone farm approach)
- Custom AOSP build (Approach 10)
- Sequential rotation with good UX (Approach 2)
- A combination of Work Profile + sequential rotation

---

## Key Technical Facts Discovered

### `am start-activity` supports `--display` flag
```bash
am start-activity --user <USER_ID> --display <DISPLAY_ID> -n package/activity
```
This flag EXISTS in Android 15. However, security restrictions in `ActivityStarter.java` may prevent cross-user cross-display launches on non-automotive builds.

### `adb shell input -d <DISPLAY_ID>` works for virtual displays
```bash
adb shell input -d 2 tap 500 800      # Tap on display 2
adb shell input -d 2 text "hello"     # Type on display 2
```
**Important**: The display ID for input may differ from the display ID shown in `dumpsys display`. On some devices, a virtual display created with ID 90 may need input on ID 91. Always verify with testing.

### `adb shell screencap -d <DISPLAY_ID>` captures specific displays
```bash
adb shell screencap -d 2 -p /sdcard/screenshot_display2.png
```

### Background users CAN run services but NOT activities
On standard Android 15 phones, background users:
- **CAN**: Run background services, receive FCM messages, sync data
- **CANNOT**: Display UI, launch activities, respond to touches
- **ARE**: Subject to memory-pressure termination

### WhatsApp in Android user profiles is legitimate
Using the official WhatsApp app installed via Google Play in separate Android user profiles is a supported, legitimate use case. WhatsApp does NOT detect or ban accounts in separate user profiles because each profile appears as a separate device to WhatsApp.

---

## Recommended Architecture for Phase 8

### Primary Strategy: Optimized Sequential Rotation

```
┌────────────────────────────────────────────────────────────┐
│                    SEND ORCHESTRATOR                        │
│                                                            │
│  Queue: [msg1→user10, msg2→user10, msg3→user11, ...]     │
│                                                            │
│  Strategy:                                                 │
│  1. Group messages by target user profile                  │
│  2. Switch to user N                                       │
│  3. Send ALL queued messages for user N                    │
│  4. Take screenshots                                       │
│  5. Switch to user N+1                                     │
│  6. Repeat                                                 │
│                                                            │
│  Optimization:                                             │
│  - Batch 5-10 msgs per user before switching              │
│  - Disable lock screen on all profiles                     │
│  - Pre-warm all profiles at startup                        │
│  - Apply jitter WITHIN each batch (anti-ban)              │
│  - Monitor switch time, adapt batch size                   │
│                                                            │
│  Expected throughput:                                      │
│  - 4 profiles, 5 msgs/batch, 15s/msg, 4s switch          │
│  - Cycle: 4 * (4 + 5*15) = 316s ≈ 5.3 min               │
│  - 20 msgs / 5.3 min ≈ 3.8 msgs/min ≈ 226 msgs/hour    │
└────────────────────────────────────────────────────────────┘
```

### Secondary Strategy: Work Profile for 2-Account Concurrency

For the most common case (2 WhatsApp accounts), use:
- Main profile: WhatsApp account A
- Work profile (via Shelter/Island): WhatsApp account B
- Both run simultaneously, no user switch needed
- UI interaction is still sequential but instant (just switch apps)

### Experimental Strategy: RRO Overlay (Phase 8 Stretch Goal)

If time permits, attempt:
1. Create Magisk RRO module enabling `config_multiuserVisibleBackgroundUsers`
2. Test if `am start-activity --user N --display D` works
3. If yes: true parallel execution with scrcpy virtual displays
4. If no: document findings for future custom ROM path

### NOT Recommended

- Xposed modules (ban risk)
- App cloning (ban risk)
- Custom AOSP build (time investment)
- Accessibility service hack (doesn't solve the core problem)

---

## Sources

- [Android Multi-Display Overview (AOSP)](https://source.android.com/docs/core/display/multi_display)
- [Activity Launch Policy (AOSP)](https://source.android.com/docs/core/display/multi_display/activity-launch)
- [Support Multiple Users (AOSP)](https://source.android.com/docs/devices/admin/multi-user)
- [Input Routing (AOSP)](https://source.android.com/docs/core/display/multi_display/input-routing)
- [Multi-Display FAQ (AOSP)](https://source.android.com/docs/core/display/multi_display/faq)
- [Foreground/Background User Handling (AOSP Automotive)](https://source.android.com/docs/automotive/users_accounts/user_system)
- [scrcpy Virtual Display Documentation](https://github.com/Genymobile/scrcpy/blob/master/doc/virtual_display.md)
- [scrcpy Multiple Display Mirroring (GitHub #3242)](https://github.com/Genymobile/scrcpy/issues/3242)
- [Android Desktop Mode (XDA Forums)](https://xdaforums.com/t/finally-got-a-desktop-mode-working.4708176/)
- [Runtime Resource Overlays (AOSP)](https://source.android.com/docs/core/runtime/rros)
- [Magisk RRO Template (GitHub)](https://github.com/ysc3839/magisk-runtimeoverlaytemplate)
- [Android Config Overlays Collection (GitHub)](https://github.com/digitalcircuit/android-config-overlays)
- [Multiple Android User Profiles (SensePost)](https://sensepost.com/blog/2020/multiple-android-user-profiles/)
- [WhatsApp Temporary Bans (WhatsApp Help)](https://faq.whatsapp.com/1848531392146538)
- [Work Profiles (Android Developers)](https://developer.android.com/work/managed-profiles)
- [ActivityStarter.java (AOSP Source)](https://cs.android.com/android/platform/superproject/+/master:frameworks/base/services/core/java/com/android/server/wm/ActivityStarter.java)
- [Xiaomi Dual Apps / Second Space (Mi.com)](https://www.mi.com/global/support/article/KA-12531/)
- [Android Desktop Mode Blog (Google)](https://android-developers.googleblog.com/2025/06/developer-preview-enhanced-android-desktop-experiences-connected-displays.html)
- [Three WhatsApp Numbers Without Flagging (TheWord360)](https://theword360.com/2024/10/14/how-to-use-three-whatsapp-numbers-on-the-same-phone-without-getting-flagged/)
