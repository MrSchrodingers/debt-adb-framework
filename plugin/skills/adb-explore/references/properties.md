# Android System Properties Reference

## Device Identity
| Property | Description |
|----------|-------------|
| `ro.product.brand` | Brand (Xiaomi, Samsung, Google) |
| `ro.product.model` | Model number |
| `ro.product.device` | Device codename |
| `ro.product.name` | Product name |
| `ro.build.fingerprint` | Full build fingerprint |
| `ro.serialno` | Serial number |
| `ro.hardware` | Hardware platform |

## Android Version
| Property | Description |
|----------|-------------|
| `ro.build.version.release` | Android version (15, 14, etc.) |
| `ro.build.version.sdk` | SDK API level (35, 34, etc.) |
| `ro.build.display.id` | Human-readable build ID |
| `ro.build.version.incremental` | Incremental build number |
| `ro.build.version.security_patch` | Security patch date (YYYY-MM-DD) |

## Hardware
| Property | Description |
|----------|-------------|
| `ro.board.platform` | SoC platform (ums9230, sm8550, etc.) |
| `ro.product.cpu.abi` | Primary ABI (arm64-v8a, armeabi-v7a) |
| `ro.product.cpu.abilist` | All supported ABIs |
| `ro.hardware.chipname` | Chip name |

## Network
| Property | Description |
|----------|-------------|
| `gsm.version.baseband` | Baseband/modem version |
| `persist.sys.timezone` | System timezone |
| `net.dns1` / `net.dns2` | DNS servers |
| `wifi.interface` | WiFi interface name |

## Battery Status Codes
| Status | Meaning |
|--------|---------|
| 1 | Unknown |
| 2 | Charging |
| 3 | Discharging |
| 4 | Not charging |
| 5 | Full |

## Health Codes
| Health | Meaning |
|--------|---------|
| 1 | Unknown |
| 2 | Good |
| 3 | Overheat |
| 4 | Dead |
| 5 | Over voltage |
| 6 | Unspecified failure |

## Common Chipset Platforms
| Platform | Manufacturer | Example |
|----------|-------------|---------|
| ums9230 | Unisoc | POCO (T615) |
| sm8550 | Qualcomm | Snapdragon 8 Gen 2 |
| mt6983 | MediaTek | Dimensity 9000 |
| exynos2200 | Samsung | Exynos 2200 |
| gs201 | Google | Tensor G2 |
