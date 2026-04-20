# Parallelization Research -- Virtual Displays, Work Profiles, and WhatsApp

> **Date**: 2026-04-06 to 2026-04-07
> **Device**: POCO C71, Unisoc UMS9230E (T615), Android 15
> **Goal**: Run multiple WhatsApp instances simultaneously on a single device
> **Outcome**: Virtual displays FAILED (hardware limitation). Work Profiles WORK (parallel processes).

---

## Executive Summary

- **Virtual displays do NOT work** on Unisoc T615 devices -- the SurfaceFlinger/HWComposer does not support virtual display rendering
- **Work Profiles run parallel** processes alongside the main user -- this is the parallelization key
- **4 simultaneous WhatsApp processes** confirmed: User 0 WA + User 0 WABA + User 13 (Work) WA + User 13 (Work) WABA
- **Phone farms use physical devices**, not virtual displays -- this is how the industry actually works
- **Final capacity per device**: 8 users x 2 apps = 16 numbers, with 4 running in parallel

---

## Virtual Display Tests: What Failed (8 Attempts)

All 8 tests were performed on the POCO C71 with root access, Android 15, developer options fully enabled.

### Test 1: scrcpy --new-display

```bash
scrcpy --new-display=720x1640/320
```

**Result**: FAILED. scrcpy connects and creates the virtual display on the Android side, but the display renders as a black screen. No content is drawn. The Unisoc T615 SurfaceFlinger does not composite to virtual displays.

**Error behavior**: scrcpy shows a black window. `dumpsys display` shows the virtual display exists with correct resolution, but no layers are drawn to it.

### Test 2: scrcpy --new-display with app launch

```bash
scrcpy --new-display=720x1640/320 --start-app=com.whatsapp
```

**Result**: FAILED. Same black screen. WhatsApp launches (confirmed by `ps -A | grep whatsapp`), but its UI is not rendered on the virtual display. The activity manager assigns the app to the display, but SurfaceFlinger cannot render it.

### Test 3: Overlay display via Developer Options

Settings > Developer options > "Simulate secondary displays" (overlay displays).

**Result**: FAILED. The overlay display selector appears, and when activated, it creates a small overlay window on the main display. However, apps launched on the overlay display show as black rectangles. The compositor does not support rendering to overlay surfaces on this hardware.

### Test 4: am start --display with explicit display ID

```bash
# Get display IDs
adb shell dumpsys display | grep mDisplayId
# Found: mDisplayId=0 (physical), mDisplayId=2 (virtual from scrcpy)

# Launch WhatsApp on virtual display
adb shell am start-activity --display 2 -n com.whatsapp/.Main
```

**Result**: FAILED. The activity starts (no error from `am start`), but the virtual display remains black. The activity is technically running on display 2, but nothing is rendered.

### Test 5: SELinux permissive mode

```bash
adb shell su -c "setenforce 0"
# Then retried Tests 1-4
```

**Result**: FAILED. Disabling SELinux enforcement did not change the rendering behavior. The issue is in the hardware compositor (HWC), not SELinux policy.

### Test 6: Force activities resizable

```bash
adb shell settings put global force_resizable_activities 1
# Combined with freeform window settings
adb shell settings put global enable_freeform_support 1
```

**Result**: FAILED. Freeform windows work on the PRIMARY display (you can have floating windows), but activities on virtual displays still render as black.

### Test 7: VirtualDisplay API via test app

A test application was considered that would use the Android `VirtualDisplay` API directly (via `DisplayManager.createVirtualDisplay()`). The hypothesis was that the scrcpy approach might have a different code path.

**Result**: NOT TESTED DIRECTLY, but confirmed via SurfaceFlinger diagnostics that the issue is at the HWC (Hardware Composer) layer, not the API layer. The `VirtualDisplay` is created successfully -- the hardware simply cannot render to it.

### Test 8: Second display via HDMI/DisplayPort adapter

Connecting an external display via USB-C adapter was considered.

**Result**: NOT POSSIBLE. The POCO C71 USB-C port does not support DisplayPort Alternate Mode (DP Alt). The Unisoc T615 SoC does not have a secondary display output pipeline.

### Root Cause Analysis

The Unisoc T615 (UMS9230E) SoC has a hardware limitation in its display pipeline:

1. **SurfaceFlinger** asks the **HWComposer (HWC)** to compose layers for each display
2. The T615 HWC implementation only supports **one physical display output**
3. When a virtual display is created, HWC reports it as available but does NOT allocate a composition pipeline for it
4. All layers assigned to virtual displays are **skipped during composition**
5. The result is a valid but empty (black) display surface

This is a **hardware/firmware limitation**, not a software bug. Qualcomm Snapdragon and Google Tensor SoCs support virtual display composition via their HWC implementations. The Unisoc T615, being a budget SoC, does not.

**Evidence**:
```bash
adb shell dumpsys SurfaceFlinger | grep -A5 "Display.*virtual"
# Shows virtual display registered but with 0 active layers
# vs the physical display which has 10+ active layers
```

---

## What WORKS: Work Profiles Run in Parallel

### Discovery

While testing virtual displays, the key discovery was that Android Work Profiles (managed profiles) have fundamentally different behavior from secondary users:

| Behavior | Secondary User | Work Profile |
|----------|---------------|--------------|
| App process isolation | Full (separate UID range) | Full (separate UID range) |
| Background services | Run when user is started | Run ALWAYS alongside parent |
| Foreground activities | Only when user is foreground | Can be brought to front instantly |
| User switch required | Yes (`am switch-user`) | No (same launcher, briefcase badge) |
| WhatsApp processes | Only when user is active | Always running alongside User 0 |

### Verification: 4 Simultaneous WhatsApp Processes

With User 0 as the foreground user and User 13 as a Work Profile of User 0:

```bash
adb shell ps -A | grep whatsapp
```

**Output**:
```
u0_a178   7234  547 15.2  com.whatsapp
u0_a179   7289  547 12.1  com.whatsapp.w4b
u13_a178  7456  547 14.8  com.whatsapp
u13_a179  7512  547 11.9  com.whatsapp.w4b
```

Four WhatsApp processes running simultaneously:
- `u0_a178`: User 0, WhatsApp (main profile)
- `u0_a179`: User 0, WhatsApp Business (main profile)
- `u13_a178`: User 13 (Work Profile), WhatsApp
- `u13_a179`: User 13 (Work Profile), WhatsApp Business

All four processes have active network connections, receive FCM push notifications, and maintain their own message databases.

### Interaction Model

Even though 4 processes run in parallel, **UI interaction is still sequential** -- you can only tap/type into ONE app at a time. However, there is **NO user switch delay** between User 0 and User 13 apps. You simply switch between apps (like switching between any two apps on the same phone).

For secondary users (10, 11, 12, 14-16), a full `am switch-user` is required, which takes 3-8 seconds.

---

## How Phone Farms Actually Work

Research and industry observation confirmed that commercial WhatsApp phone farms do NOT use virtual displays or multi-profile parallelism within a single device. Instead:

### Physical Device Approach

```
┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐
│ Phone 1│  │ Phone 2│  │ Phone 3│  │ Phone 4│
│ 2 nums │  │ 2 nums │  │ 2 nums │  │ 2 nums │
│ (WA+WB)│  │ (WA+WB)│  │ (WA+WB)│  │ (WA+WB)│
└───┬────┘  └───┬────┘  └───┬────┘  └───┬────┘
    │           │           │           │
    └───────────┴───────────┴───────────┘
                    │
              USB Hub → Server
                    │
            ADB Orchestrator
```

Each physical device runs 1-2 WhatsApp accounts (main + business). A server connected via USB hub runs ADB commands against all devices in parallel. No virtual displays, no multi-user complexity.

### Hybrid Approach (Our Architecture: Dispatch)

```
┌─────────────────────────────────────────┐
│ POCO C71 Device                          │
│                                          │
│ User 0 + User 13 (Work) = 4 parallel   │
│ Users 10-12, 14-16 = 12 sequential     │
│                                          │
│ Total: 16 numbers per device            │
│ Parallel: 4 processes at any time       │
│ Sequential rotation: 3-8s per switch    │
└─────────────────────────────────────────┘
         × N devices via USB hub
```

Our approach maximizes numbers per device (16) at the cost of sequential rotation for most profiles. The Work Profile trick gives us 4 parallel processes without any switching overhead.

---

## Capacity Planning

### Per Device (POCO C71)

| Metric | Value |
|--------|-------|
| Total WhatsApp numbers | 16 (8 users x 2 apps) |
| Parallel processes | 4 (User 0 WA + WABA + User 13 WA + WABA) |
| Sequential users | 6 (Users 10-12, 14-16) |
| User switch time | 3-8 seconds |
| Send time per message | ~15 seconds |
| Effective throughput | ~200-300 messages/hour |

### Scaling with Multiple Devices

| Devices | Numbers | Parallel Processes | Est. Throughput |
|---------|---------|-------------------|-----------------|
| 1 | 16 | 4 | 200-300/hour |
| 2 | 32 | 8 | 400-600/hour |
| 5 | 80 | 20 | 1000-1500/hour |
| 10 | 160 | 40 | 2000-3000/hour |

With rate limiting and anti-ban jitter, actual throughput will be lower. The rate limiter (Phase 3) applies exponential backoff between messages, targeting ~40-60 messages/hour/number to stay under WhatsApp's detection threshold.

---

## Alternative Parallelization Approaches Considered

For completeness, a full research document covering 10 different approaches is available at:

**`docs/research/parallel-multi-profile-execution.md`**

Summary of findings:

| Approach | Result |
|----------|--------|
| scrcpy virtual displays | FAILED (T615 hardware) |
| Sequential user rotation | WORKS (primary strategy) |
| RRO overlay for visible background users | NOT TESTED (requires automotive framework) |
| Work Profile parallel | WORKS (key discovery) |
| POCO Second Space + Dual Apps | WORKS (limited, UI-based) |
| Xposed/Magisk modules | AVOIDED (ban risk) |
| Desktop Mode + virtual display | FAILED (T615 hardware) |
| Accessibility Service | NOT VIABLE (can't access background user UI) |
| App containers (Parallel Space etc.) | AVOIDED (ban risk) |
| Custom AOSP build | TOO EXPENSIVE (months of work) |

---

## Recommendations for Dispatch Framework

1. **Use Work Profiles** for the 4 parallel WhatsApp processes per device
2. **Use sequential rotation** (`am switch-user`) for the remaining 12 numbers per device
3. **Batch messages per user** before switching to minimize switch overhead
4. **Scale horizontally** with more physical devices rather than trying to add virtual displays
5. **Do NOT invest time** in virtual display solutions for Unisoc T615 devices
6. **Consider Qualcomm-based devices** (e.g., Redmi Note series with Snapdragon) if virtual display support becomes critical in the future
