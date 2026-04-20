# Android Security Audit Checklist

## Device Configuration
- [ ] Security patch less than 3 months old
- [ ] Full-disk encryption enabled (ro.crypto.state = encrypted)
- [ ] SELinux enforcing (getenforce = Enforcing)
- [ ] Bootloader locked (ro.boot.flash.locked = 1)
- [ ] Verified boot green (ro.boot.verifiedbootstate = green)
- [ ] Screen lock enabled
- [ ] USB debugging disabled for production use
- [ ] Unknown sources disabled
- [ ] Developer options disabled for production use

## Network
- [ ] Private DNS enabled (DNS-over-TLS)
- [ ] No proxy configured (unless intentional)
- [ ] No unexpected open ports
- [ ] No ADB over network (tcp port)
- [ ] WiFi connection uses WPA2/WPA3

## Apps
- [ ] No sideloaded apps from unknown sources
- [ ] No device admin apps (unless MDM)
- [ ] No accessibility service apps (unless needed)
- [ ] No apps with SYSTEM_ALERT_WINDOW (unless trusted)
- [ ] No apps with SEND_SMS permission (unless messaging app)
- [ ] No apps with excessive permissions (>15)
- [ ] No recently installed suspicious apps
- [ ] All apps from Play Store or trusted sources

## Data
- [ ] No sensitive files in Downloads/
- [ ] Clipboard cleared of sensitive data
- [ ] No credentials stored in plaintext
- [ ] Backup encryption enabled

## Runtime
- [ ] No suspicious background services
- [ ] No unexpected wake locks
- [ ] No unusual network connections
- [ ] Battery usage patterns normal
