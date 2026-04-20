# Device Setup Overview -- POCO C71 / Redmi A5 for Dispatch ADB Framework

> **Date**: 2026-04-06 to 2026-04-07
> **Devices**: POCO C71 (codename "serenity", model 25028PC03G)
> **Operator**: Matheus Munhoz
> **Purpose**: WhatsApp automation phone farm for Dispatch ADB Framework

---

## Device Specifications

| Property | Value |
|----------|-------|
| **Brand** | POCO (Xiaomi) |
| **Model** | 25028PC03G |
| **Marketing Name** | POCO C71 / Redmi A5 |
| **Codename** | serenity |
| **Chipset** | Unisoc UMS9230E (T615 / T7250) |
| **CPU** | 8x Cortex-A55 @ ~1.8 GHz (ARM64-v8a) |
| **RAM** | ~2.8 GB (2855412 kB) |
| **Storage** | 64 GB (50 GB usable /data) |
| **Screen** | 720x1640, 320 DPI |
| **Android** | 15 (API 35) |
| **SDK** | 35 |
| **Security Patch** | 2025-09-01 |
| **Build** | A15.0.13.0.VGWMIXM |
| **Firmware** | MIUI V140 (HyperOS-based) |
| **Battery** | Li-poly, ~5000 mAh |
| **Baseband** | 4G_MODEM_22B_W24.52.2_P16 (qogirl6_modem) |

### Device Serials

| Device | Serial | Role |
|--------|--------|------|
| Device 1 (POCO Serenity) | `9b01005930533036340030832250ac` | Primary dev/test device |
| Device 2 (POCO Serenity) | `9b0100593053303634003083239bac` | Secondary device |

---

## What Was Achieved

### 1. Bootloader Unlock
- Unlocked via CVE-2022-38694 exploit on Windows
- Required specific UMS9230E FDL files (NOT UMS9230 universal)
- Spreadtrum USB driver + spd_dump.exe

### 2. Root via Magisk
- Extracted boot.img from official Recovery ROM
- Patched with Magisk v28.1
- Flashed to boot_a partition
- Full root access confirmed

### 3. Multi-User Setup (8 Profiles)
- Increased user limit to 8 via `fw.max_users`
- Created secondary users and one Work Profile
- Work Profile (user 13) runs IN PARALLEL with main user (key discovery)

### 4. Device Hygienization
- Removed 90+ bloatware packages per user
- Configured silence (all volumes 0, DND)
- Set maximum brightness, infinite screen timeout
- Disabled lock screens on all profiles
- Restored SMS and Contacts providers for 2FA

### 5. WhatsApp Parallelization Discovery
- Virtual displays DO NOT WORK on Unisoc T615 (hardware limitation)
- Work Profiles run processes in parallel with main user
- 4 simultaneous WhatsApp processes confirmed: u0 WA + u0 WABA + u13 WA + u13 WABA
- Final capacity: 8 users x 2 apps (WA + WABA) = 16 numbers per device
- Effective parallel: 4 processes (2 per active user context)

---

## Architecture: Users, Profiles, and Apps

```
POCO C71 (serenity)
├── User 0 (Owner - "Main Oralsin 2")
│   ├── com.whatsapp        ← WhatsApp #1
│   └── com.whatsapp.w4b    ← WhatsApp Business #2
│
├── User 10 ("Oralsin 2 1")
│   ├── com.whatsapp        ← WhatsApp #3
│   └── com.whatsapp.w4b    ← WhatsApp Business #4
│
├── User 11 ("Oralsin 2 2")
│   ├── com.whatsapp        ← WhatsApp #5
│   └── com.whatsapp.w4b    ← WhatsApp Business #6
│
├── User 12 ("Oralsin 2 3")
│   ├── com.whatsapp        ← WhatsApp #7
│   └── com.whatsapp.w4b    ← WhatsApp Business #8
│
├── User 13 (Work Profile of User 0 - "Work")  ← PARALLEL with User 0
│   ├── com.whatsapp        ← WhatsApp #9
│   └── com.whatsapp.w4b    ← WhatsApp Business #10
│
├── User 14 ("Profile 5")
│   ├── com.whatsapp        ← WhatsApp #11
│   └── com.whatsapp.w4b    ← WhatsApp Business #12
│
├── User 15 ("Profile 6")
│   ├── com.whatsapp        ← WhatsApp #13
│   └── com.whatsapp.w4b    ← WhatsApp Business #14
│
└── User 16 ("Profile 7")
    ├── com.whatsapp        ← WhatsApp #15
    └── com.whatsapp.w4b    ← WhatsApp Business #16
```

### Execution Model

```
┌─────────────────────────────────────────────────────────────────┐
│                     PARALLEL EXECUTION                          │
│                                                                 │
│  Active User Context (e.g., User 0 as foreground):             │
│  ┌──────────────────────┐  ┌──────────────────────┐            │
│  │ User 0: com.whatsapp │  │ User 0: com.whatsapp │            │
│  │ (foreground process)  │  │ .w4b (bg service)    │            │
│  └──────────────────────┘  └──────────────────────┘            │
│  ┌──────────────────────┐  ┌──────────────────────┐            │
│  │ User 13 (Work):      │  │ User 13 (Work):      │            │
│  │ com.whatsapp         │  │ com.whatsapp.w4b     │            │
│  │ (parallel process)   │  │ (parallel process)   │            │
│  └──────────────────────┘  └──────────────────────┘            │
│                                                                 │
│  Sequential User Rotation for Users 10-12, 14-16:             │
│  am switch-user N → send batch → am switch-user N+1           │
│  (3-8 second switch time per user)                              │
└─────────────────────────────────────────────────────────────────┘
```

### Throughput Estimate

- **4 parallel WhatsApp processes** (owner + work profile, WA + WABA each)
- **6 sequential user rotations** (users 10-12, 14-16)
- **Batch size**: 5-10 messages per user before switching
- **Switch time**: 3-8 seconds
- **Send time per message**: ~15 seconds (open contact, type, send, screenshot)
- **Estimated throughput**: ~200-300 messages/hour per device

---

## Full Process Pipeline

```
1. Bootloader Unlock (Windows)     → docs/device-setup/01-bootloader-unlock.md
2. Root via Magisk                 → docs/device-setup/02-root-magisk.md
3. Multi-User Setup                → docs/device-setup/03-multi-user-setup.md
4. Device Hygienization            → docs/device-setup/04-hygienization.md
5. Parallelization Research        → docs/device-setup/05-parallelization-research.md
6. ADB Troubleshooting             → docs/device-setup/06-adb-troubleshooting.md
```

---

## Critical Notes

1. **Chipset identification**: The device reports `ro.board.platform=ums9230` but the actual SoC variant is **UMS9230E** (T615). The universal UMS9230 unlock files DO NOT WORK. You must use the UMS9230E-specific package.

2. **Factory reset clears ADB**: After bootloader unlock or factory reset, ADB authorization is lost. The fix is `adb kill-server; sudo $(which adb) start-server`.

3. **USB tethering breaks ADB**: Enabling USB tethering changes the USB mode from MTP/PTP to RNDIS, which breaks ADB connectivity. Always use WiFi for internet on the devices.

4. **Work Profile is the parallelization key**: Regular secondary users require `am switch-user` (sequential). Work Profiles run alongside the owner user, enabling true parallel WhatsApp processes.

5. **PIN for all profiles**: `12345` (removed after root via `locksettings clear`).
