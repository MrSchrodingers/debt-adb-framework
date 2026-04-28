# APK Reverse Toolkit

Research utilities for tracking WhatsApp APK changes over time. Goal: detect anti-ban
mechanism changes before they affect Dispatch operations in production.

## Prerequisites

```bash
sudo apt install apktool jq
```

Verify:
```bash
apktool --version   # expect 2.x
jq --version        # expect 1.6+
adb version         # expect 1.0.41+
```

## Workflow

### 1. Monthly snapshot via cron

Add to root crontab (`sudo crontab -e`):

```cron
0 3 1 * * /var/www/debt-adb-framework/scripts/apk-snapshot.sh
```

This pulls `com.whatsapp` from the first connected device on the 1st of each month at 3 AM,
saves to `/var/backups/whatsapp-apks/`, and updates the metadata index
`/var/backups/whatsapp-apks/apk_versions.json`.

Override targets with env vars:
```bash
DEVICE_SERIAL=emulator-5554 PACKAGE=com.whatsapp.w4b APK_BACKUP_DIR=/mnt/nas/apks \
  /path/to/apk-snapshot.sh
```

### 2. Manual diff after a WhatsApp update

When WhatsApp pushes a new version (check `apk_versions.json` for a new entry):

```bash
cd /var/www/debt-adb-framework
./scripts/apk-diff.sh \
  /var/backups/whatsapp-apks/com.whatsapp-2.24.X.apk \
  /var/backups/whatsapp-apks/com.whatsapp-2.25.X.apk
```

The report is saved to `reports/apk-diff-<v1>-vs-<v2>.md`.

### 3. What to look for in diffs

#### AndroidManifest.xml permissions
New permissions added to the manifest can reveal new data-collection or
anti-fraud vectors:
- `READ_PHONE_STATE`, `READ_CONTACTS` — fingerprinting escalation
- New `<service>` or `<receiver>` entries in background — new monitoring agents
- Changes to `targetSdkVersion` — may affect how ADB automation is sandboxed

#### Smali classes in security namespaces
Watch for new or modified files under:
```
smali_classes*/com/whatsapp/security/
smali_classes*/com/whatsapp/registration/
smali_classes*/com/whatsapp/account/
```
New classes here often map to new ban-detection heuristics (typing cadence,
screen-off detection, accessibility-service probing).

#### Ban/policy-related strings
The diff tool automatically filters `res/values/strings.xml` for keywords:
`ban`, `block`, `suspend`, `restrict`, `violation`, `policy`.
New entries here surface new UI error messages that indicate new ban categories
before they appear in documentation.

#### Smali method-level review
For files flagged by the automated diff, decompile to Java with
[jadx](https://github.com/skylot/jadx) for deeper analysis:

```bash
jadx -d out/ /var/backups/whatsapp-apks/com.whatsapp-2.25.X.apk
grep -rn "automationDetect\|accessibilityService\|screenOff" out/
```

## Output files

| File | Description |
|------|-------------|
| `/var/backups/whatsapp-apks/*.apk` | Versioned APK snapshots |
| `/var/backups/whatsapp-apks/apk_versions.json` | Metadata index (version, sha256, size, timestamp) |
| `reports/apk-diff-<v1>-vs-<v2>.md` | Human-readable diff report |

## Limitations

- `apktool` does not fully decompile obfuscated code — smali output is the primary artifact.
- WhatsApp uses ProGuard; class names in security packages may change between releases.
- APK splits (XAPK) are not handled; this tool targets the base APK only.
- WhatsApp Business (`com.whatsapp.w4b`) must be snapshotted separately by setting
  `PACKAGE=com.whatsapp.w4b`.
