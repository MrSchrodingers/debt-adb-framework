# Android Notification Channels

## Concept
Since Android 8 (API 26), apps must assign notifications to channels.
Users can control notification behavior per channel.

## Listing Channels via ADB

```bash
# List all notification channels for an app
adb shell dumpsys notification | grep -A5 "channels:" | grep -B1 "importance"

# Detailed channel info for specific app
adb shell cmd notification list_channels <package> <user_id>
```

## Channel Importance Levels

| Level | Value | Behavior |
|-------|-------|----------|
| NONE | 0 | Blocked |
| MIN | 1 | No sound, no visual |
| LOW | 2 | No sound |
| DEFAULT | 3 | Sound |
| HIGH | 4 | Sound + heads-up |
| MAX | 5 | Sound + full-screen intent |

## Modifying Channels via ADB

```bash
# Block a specific channel
adb shell cmd notification set_importance <package> <channel_id> 0

# Set to silent
adb shell cmd notification set_importance <package> <channel_id> 1

# Check current importance
adb shell cmd notification get_importance <package> <channel_id>
```

## Common Spam Channels

| App | Channel | Purpose |
|-----|---------|---------|
| Play Store | `updates_available` | Update notifications |
| Play Store | `promotions` | Promotional content |
| Chrome | `browser` | Browser notifications (web push) |
| YouTube | `reminder_notification` | Video reminders |
| Google | `search_promo` | Search promotions |

## Batch Operations

```bash
# Block all channels for an app
for channel in $(adb shell cmd notification list_channels <pkg> 0 | grep "id=" | sed "s/.*id=//;s/ .*//"); do
  adb shell cmd notification set_importance <pkg> "$channel" 0
done
```
