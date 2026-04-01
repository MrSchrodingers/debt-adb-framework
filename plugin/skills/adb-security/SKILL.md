---
name: adb-security
description: >
  This skill should be used when the user asks to "audit phone security", "check phone
  permissions", "scan phone for threats", "security check android", "phone privacy audit",
  "check app permissions", "find suspicious apps", "phone security scan", "check if phone
  is compromised", "verify phone security", "check dangerous permissions", or wants to
  perform a security assessment of a connected Android device via ADB.
---

# ADB Security Auditor

Comprehensive security assessment of Android devices via ADB. Checks permissions,
encryption, network exposure, suspicious apps, debug settings, and known vulnerabilities.

## Security Audit Workflow

### Phase 1: System Security Posture

```bash
# Security patch level (compare against current date)
adb shell getprop ro.build.version.security_patch

# Encryption status
adb shell getprop ro.crypto.state                  # should be "encrypted"
adb shell dumpsys diskstats | grep "Encryption"

# SELinux status
adb shell getenforce                                # should be "Enforcing"

# USB debugging (should be off for end users)
adb shell settings get global adb_enabled

# Unknown sources
adb shell settings get secure install_non_market_apps

# Developer options
adb shell settings get global development_settings_enabled

# Screen lock
adb shell dumpsys trust | grep -i "device locked"

# Bootloader
adb shell getprop ro.boot.verifiedbootstate         # should be "green"
adb shell getprop ro.boot.flash.locked               # should be "1"
```

### Phase 2: Dangerous Permissions Audit

Scan apps with high-risk permissions:

```bash
# Apps with CAMERA
adb shell dumpsys package | grep -B1 "android.permission.CAMERA" | grep "Package"

# Apps with RECORD_AUDIO
adb shell dumpsys package | grep -B1 "android.permission.RECORD_AUDIO" | grep "Package"

# Apps with READ_SMS
adb shell dumpsys package | grep -B1 "android.permission.READ_SMS" | grep "Package"

# Apps with ACCESS_FINE_LOCATION
adb shell dumpsys package | grep -B1 "android.permission.ACCESS_FINE_LOCATION" | grep "Package"

# Apps with READ_CONTACTS
adb shell dumpsys package | grep -B1 "android.permission.READ_CONTACTS" | grep "Package"

# Apps with SEND_SMS (high risk - financial fraud)
adb shell dumpsys package | grep -B1 "android.permission.SEND_SMS" | grep "Package"

# Apps that can draw over other apps (overlay attacks)
adb shell dumpsys package | grep -B1 "android.permission.SYSTEM_ALERT_WINDOW" | grep "Package"

# Device admin apps
adb shell dumpsys device_policy | grep -A2 "Admin"

# Accessibility services (can read/control everything)
adb shell settings get secure enabled_accessibility_services
```

### Phase 3: Network Security

```bash
# Active connections
adb shell netstat -tlnp 2>/dev/null || adb shell ss -tlnp

# DNS configuration
adb shell getprop net.dns1
adb shell getprop net.dns2
adb shell settings get global private_dns_mode
adb shell settings get global private_dns_specifier

# VPN status
adb shell dumpsys connectivity | grep -i "vpn"

# Proxy settings (could indicate MITM)
adb shell settings get global http_proxy
adb shell settings get global global_http_proxy_host

# Open ports
adb shell netstat -an | grep LISTEN
```

### Phase 4: Suspicious App Detection

```bash
# Recently installed apps (check for sideloaded malware)
adb shell dumpsys package | grep -E "firstInstallTime|lastUpdateTime" | sort -t= -k2 -r | head -20

# Apps installed from unknown sources (not Play Store)
adb shell pm list packages -i | grep -v "com.android.vending" | grep -v "com.google"

# Apps with excessive permissions (more than 10)
adb shell "for pkg in $(pm list packages -3 | sed 's/package://'); do
  count=$(dumpsys package $pkg | grep -c 'android.permission')
  if [ $count -gt 10 ]; then echo \"$count $pkg\"; fi
done" 2>/dev/null | sort -rn

# Running services from third-party apps
adb shell dumpsys activity services | grep -E "ServiceRecord.*u0a" | grep -v "com.google\|com.android"

# Background battery drain (potential spyware indicator)
adb shell dumpsys batterystats | grep -E "Uid.*wake" | sort -t: -k2 -rn | head -10
```

### Phase 5: Data Exposure Check

```bash
# Check for files on external storage
adb shell ls /sdcard/Download/ 2>/dev/null | head -20
adb shell ls /sdcard/DCIM/ 2>/dev/null | head -10

# Check clipboard content (may contain sensitive data)
adb shell service call clipboard 2 s16 com.android.shell 2>/dev/null

# Check if USB debugging is exposed over network
adb shell getprop service.adb.tcp.port
```

## Risk Assessment Output

Present findings in a security report with severity levels:

| Severity | Criteria |
|----------|----------|
| CRITICAL | Device compromise indicators, active spyware, root exploits |
| HIGH | Outdated security patches (>3 months), disabled encryption, device admin malware |
| MEDIUM | Excessive permissions, sideloaded apps, USB debug enabled |
| LOW | Minor privacy concerns, unnecessary permissions |
| INFO | Informational findings, configuration notes |

## Remediation Commands

```bash
# Revoke a specific permission from an app
adb shell pm revoke <package> <permission>

# Disable USB debugging remotely
adb shell settings put global adb_enabled 0

# Enable Private DNS
adb shell settings put global private_dns_mode hostname
adb shell settings put global private_dns_specifier dns.google

# Remove device admin (before uninstalling)
adb shell dpm remove-active-admin <component>

# Disable an app without uninstalling
adb shell pm disable-user --user 0 <package>
```

## Additional Resources

- **`references/permissions-risk.md`** - Android permissions classified by risk level
- **`references/security-checklist.md`** - Full security audit checklist
