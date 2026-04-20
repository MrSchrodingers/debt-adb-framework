---
name: adb-spam-cleanup
description: >
  This skill should be used when the user asks to "stop phone notifications",
  "block spam notifications", "disable notifications", "clean up notifications",
  "stop app from sending notifications", "notification spam", "too many notifications",
  "block ads on phone", "remove phone ads", "stop pop-ups", "disable ad notifications",
  "notification management", or wants to manage, block, or clean up notification
  spam and ads on an Android device via ADB.
---

# ADB Spam & Notification Cleanup

Identify and eliminate notification spam, ad-serving apps, and unwanted pop-ups
on Android devices via ADB. No root required.

## Diagnosis: Identify Spam Sources

### Step 1: Map Active Notifications

```bash
# Count notifications by package
adb shell "dumpsys notification --noredact" | grep -oP 'pkg=\K[^ ]+' | sort | uniq -c | sort -rn

# Show notification details (title, text, time)
adb shell "dumpsys notification --noredact" | grep -E "pkg=|android.title|android.text|postTime" | head -60
```

### Step 2: Identify Ad/Spam Packages

Known notification spammers by vendor:

| Package | Vendor | Type |
|---------|--------|------|
| `com.xiaomi.mipicks` | Xiaomi | App store promos |
| `com.miui.msa.global` | Xiaomi | System ads |
| `com.xiaomi.discover` | Xiaomi | Promotional content |
| `com.miui.analytics.go` | Xiaomi | Telemetry/promos |
| `com.samsung.android.app.spage` | Samsung | Samsung Free |
| `com.coloros.bootreg` | OPPO/Realme | Promotions |
| `com.facebook.appmanager` | Facebook | Install prompts |
| `com.google.android.apps.messaging` | Google | RCS promos |

### Step 3: Check Background Services

```bash
# Services that may generate notifications
adb shell dumpsys activity services | grep -E "ServiceRecord" | grep -v "com.google.android.gms\|com.android" | head -20

# Check notification listeners (apps reading ALL notifications)
adb shell settings get secure enabled_notification_listeners
```

## Remediation Levels

### Level 1: Disable Notifications Per App (least destructive)

```bash
# Block ALL notifications from a specific app
adb shell cmd notification suspend_all <package>

# Block notification channel (granular)
adb shell cmd notification set_bubbles <package> <channel_id> 0

# Alternative: revoke POST_NOTIFICATIONS permission (Android 13+)
adb shell pm revoke <package> android.permission.POST_NOTIFICATIONS
```

### Level 2: Disable App (keeps installed, stops all activity)

```bash
# Disable app for current user
adb shell pm disable-user --user 0 <package>

# Re-enable later if needed
adb shell pm enable <package>
```

### Level 3: Uninstall for User (removes from app drawer)

```bash
# Uninstall but keep data
adb shell pm uninstall -k --user 0 <package>

# For all user profiles
for user in $(adb shell pm list users | grep -oP '\{\K\d+'); do
  adb shell pm uninstall -k --user "$user" "<package>"
done
```

### Level 4: Restrict Background Activity

```bash
# Force app into restricted battery mode (limits background)
adb shell cmd appops set <package> RUN_IN_BACKGROUND deny
adb shell cmd appops set <package> RUN_ANY_IN_BACKGROUND deny

# Restrict background data
adb shell cmd netpolicy add restrict-background-whitelist <uid>
# Or deny:
adb shell cmd netpolicy set restrict-background true
```

## Bulk Notification Cleanup

### Dismiss All Active Notifications

```bash
# Service call to dismiss all
adb shell service call notification 1
```

### Mass-Disable Notifications for Known Spammers

```bash
SPAM_PACKAGES=(
  com.xiaomi.mipicks
  com.miui.msa.global
  com.xiaomi.discover
  com.miui.analytics.go
  com.facebook.appmanager
  com.google.android.apps.messaging
)

for pkg in "${SPAM_PACKAGES[@]}"; do
  adb shell pm revoke "$pkg" android.permission.POST_NOTIFICATIONS 2>/dev/null
  echo "Notifications blocked: $pkg"
done
```

## Ad Blocking Strategies

### DNS-Based Ad Blocking

```bash
# Set Private DNS to ad-blocking provider
adb shell settings put global private_dns_mode hostname
adb shell settings put global private_dns_specifier dns.adguard-dns.com

# Alternatives:
# dns.adguard-dns.com   - AdGuard DNS
# dns.nextdns.io        - NextDNS (customizable)
# family.cloudflare-dns.com - Cloudflare with malware blocking
```

### Host-File Based (requires root or ADB push)

```bash
# Check current hosts
adb shell cat /system/etc/hosts

# Note: modifying /system/etc/hosts typically requires root
# Alternative: use a local VPN app like AdGuard/Blokada
```

## Monitoring

### Watch Notifications in Real-Time

```bash
# Monitor notification events via logcat
adb logcat -s NotificationService:V

# Filter for specific events
adb logcat | grep -iE "notify|notification|toast" | grep -v "DEBUG"
```

### Audit Notification History

```bash
# Recent notification stats
adb shell dumpsys notification --stats

# Notification policy
adb shell dumpsys notification | grep -A10 "Zen Mode"
```

## Do Not Disturb Configuration

```bash
# Enable DND
adb shell settings put global zen_mode 1

# Disable DND
adb shell settings put global zen_mode 0

# DND modes:
# 0 = Off
# 1 = Priority only
# 2 = Total silence
# 3 = Alarms only
```

## Additional Resources

- **`references/notification-channels.md`** - How Android notification channels work
