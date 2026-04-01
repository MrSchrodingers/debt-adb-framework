# Android Permissions Risk Classification

## CRITICAL - Full Device Access
| Permission | Risk | Abuse Vector |
|-----------|------|--------------|
| BIND_DEVICE_ADMIN | Device takeover | Can wipe device, set lock, block uninstall |
| BIND_ACCESSIBILITY_SERVICE | Full screen read/control | Keylogger, credential theft |
| SYSTEM_ALERT_WINDOW | Screen overlay | Phishing overlays, tap-jacking |
| BIND_VPN_SERVICE | All traffic interception | MITM, data exfiltration |
| BIND_NOTIFICATION_LISTENER_SERVICE | Read all notifications | OTP theft, message interception |

## HIGH - Sensitive Data Access
| Permission | Risk | Abuse Vector |
|-----------|------|--------------|
| READ_SMS / RECEIVE_SMS | SMS interception | 2FA bypass, financial fraud |
| SEND_SMS | Send SMS silently | Premium SMS fraud, spreading malware |
| READ_CALL_LOG | Call history access | Social engineering |
| READ_CONTACTS | Contact list access | Spam, social engineering |
| READ_PHONE_STATE | Device identifiers | Tracking, fingerprinting |
| CAMERA | Silent photo/video | Surveillance |
| RECORD_AUDIO | Silent recording | Surveillance, eavesdropping |
| ACCESS_FINE_LOCATION | GPS tracking | Stalking, surveillance |
| READ_EXTERNAL_STORAGE | File access | Data theft |
| WRITE_EXTERNAL_STORAGE | File modification | Ransomware, data manipulation |

## MEDIUM - Behavioral Tracking
| Permission | Risk | Abuse Vector |
|-----------|------|--------------|
| ACCESS_COARSE_LOCATION | Approximate location | General tracking |
| ACCESS_BACKGROUND_LOCATION | Location when app closed | Persistent tracking |
| ACTIVITY_RECOGNITION | Physical activity | Behavioral profiling |
| ACCESS_WIFI_STATE | WiFi network info | Location inference |
| BLUETOOTH_CONNECT | Bluetooth devices | Device fingerprinting |
| READ_CALENDAR | Calendar events | Schedule surveillance |
| GET_ACCOUNTS | Account list | Identity mapping |

## LOW - Operational
| Permission | Risk | Abuse Vector |
|-----------|------|--------------|
| INTERNET | Network access | Required for most apps, enables exfiltration |
| FOREGROUND_SERVICE | Background execution | Battery drain, persistent tracking |
| RECEIVE_BOOT_COMPLETED | Auto-start | Persistence mechanism |
| WAKE_LOCK | Prevent sleep | Battery drain |
| VIBRATE | Vibration control | Annoyance |
| REQUEST_INSTALL_PACKAGES | Install APKs | Dropper for malware |

## Permission Audit Commands

```bash
# List all granted permissions for an app
adb shell dumpsys package <pkg> | grep "granted=true"

# List all runtime permissions for an app
adb shell dumpsys package <pkg> | grep -E "permission.*granted"

# Revoke a permission
adb shell pm revoke <pkg> android.permission.CAMERA

# Grant a permission
adb shell pm grant <pkg> android.permission.ACCESS_FINE_LOCATION

# Reset all permissions for an app
adb shell pm reset-permissions <pkg>
```
