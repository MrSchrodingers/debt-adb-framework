# Multi-User Fleet Setup (POCO C71 / Redmi A5)

After the device is rooted (`docs/devices/poco-c71-root-procedure.md`),
this document covers:

1. creating up to 8 secondary users (so a single device runs 4 WA + 4
   WAB accounts in parallel),
2. bypassing the per-user Setup Wizard (which Xiaomi gates behind a
   network handshake that is unreliable in lab settings),
3. propagating the WhatsApp APK from user 0 to every secondary,
4. registering each profile with the operator-supplied chip,
5. validating the result via the Dispatch root extractor.

The same logic is implemented end-to-end in:

- `scripts/bootstrap-poco-device.sh` (CLI, HITL prompts in pt-BR),
- `packages/ui/src/components/device-setup-wizard.tsx` (UI wizard with
  step-by-step accordion),
- `packages/core/src/api/setup-wizard.ts` (REST endpoints +
  `device_setup_wizard_state` SQLite persistence; idempotent and
  re-entrant).

## 0. Prerequisites

| Item | Source |
|---|---|
| Rooted POCO C71 with PIF + Zygisk-Assistant | `poco-c71-root-procedure.md` |
| `adb` reachable | `adb devices` lists the serial |
| Dispatch core running | health check at `http://127.0.0.1:8080/api/v1/health` |
| `DISPATCH_API_KEY` env var | `.env` of the core service |

## 1. User creation

Android multi-user is gated by the framework. Even with root, you must
use `cmd user create-user` (not the legacy `pm create-user`, which is
deprecated and broken on Android 14+).

### One-shot per user

```bash
adb -s "$SERIAL" shell \
  'su -c "cmd user create-user --user-type android.os.usertype.full.SECONDARY \"Oralsin 1 1\""'
# => Success: created user id 11
```

> The Android framework picks the next free uid; you cannot pin a
> specific uid. POCO #1 ended up with `0/10/11/12/21/22/23/24/25` only
> because users were created/destroyed several times. The
> wizard/bootstrap script does NOT try to force specific uids -- it
> records whichever uid the OS hands back.

### Bulk

```bash
for n in 1 2 3 4; do
  adb -s "$SERIAL" shell \
    "su -c 'cmd user create-user --user-type android.os.usertype.full.SECONDARY \"Oralsin 1 $n\"'"
done
```

To rename later (e.g. correct typos): `Settings -> Users` UI on the
device, OR `su -c "cmd user set-name $UID 'NewName'"`.

The system clone (uid `25` on POCO #1) is auto-managed by ContextHub
and should not be created manually. Leave it alone.

## 2. Setup Wizard bypass per user

Newly created Xiaomi profiles boot into the Setup Wizard
(`com.android.provision`, `com.google.android.setupwizard`). On C71
that flow makes a few network calls that hang in lab environments,
and you cannot reach the launcher of a profile that has not finished
the wizard.

The Dispatch endpoint `POST /api/v1/devices/:serial/profiles/:uid/bypass-setup-wizard`
encapsulates the safe sequence (root required, `force: true` opt-in).
Underlying commands per profile:

```bash
UID=11
adb -s "$SERIAL" shell "su -c 'am start-user $UID'"

# Disable Setup Wizard packages for this user
for pkg in com.google.android.setupwizard com.android.provision com.miui.cloudbackup; do
  adb -s "$SERIAL" shell "su -c 'pm disable --user $UID $pkg'"
done

# Mark the wizard as completed in settings (per-user keys)
adb -s "$SERIAL" shell "su -c 'settings put --user $UID secure user_setup_complete 1'"
adb -s "$SERIAL" shell "su -c 'settings put --user $UID global setup_wizard_has_run 1'"
adb -s "$SERIAL" shell "su -c 'settings put --user $UID global device_provisioned 1'"

# Launch HOME inside the user
adb -s "$SERIAL" shell \
  "su -c 'am start --user $UID -a android.intent.action.MAIN -c android.intent.category.HOME'"
```

> **Destructive**. A malformed bypass leaves the profile partially
> provisioned and you may need to delete + recreate the user. The
> wizard endpoint requires `{ "force": true }`. The UI shows a confirm
> modal before each invocation.

## 3. Install WhatsApp per user

Once user 0 has WhatsApp + WhatsApp Business installed, propagate the
APKs to every secondary via `pm install-existing` -- this points the
secondary user at the existing APK in `/data/app/`, no re-download.

```bash
for UID in 10 11 12; do
  adb -s "$SERIAL" shell "cmd package install-existing --user $UID com.whatsapp"
  adb -s "$SERIAL" shell "cmd package install-existing --user $UID com.whatsapp.w4b"
done
```

This is **idempotent**: running twice prints
`Package com.whatsapp installed for user: $UID` both times.

The Dispatch endpoint
`POST /api/v1/devices/:serial/setup/install-wa-per-user` does the loop
for you and persists the (uid -> [packages]) map in the wizard state.

## 4. First-launch creates the data dir

`pm install-existing` does NOT create `/data/user/$UID/com.whatsapp/`.
The data directory only materializes when the app launches once for
that user. The wizard step `Abrir WhatsApp` invokes:

```bash
adb -s "$SERIAL" shell \
  "am start --user $UID -n com.whatsapp/com.whatsapp.HomeActivity"
```

with a foreground-verification fallback to the `LAUNCHER` intent for
profiles whose `PackageManager` has not yet indexed the explicit
activity. If the `dumpsys window | grep mCurrentFocus` does not show
`com.whatsapp` after 1.5 s, the endpoint returns a 500 with diagnostic
hints (Setup Wizard intercepted, package missing for user, etc.).

## 5. Registration (HITL)

QR or SMS login MUST happen on the physical device -- WhatsApp blocks
ADB-driven OTP collection at the framework level. The wizard exposes
the loop:

1. Operator inserts the chip for the next number into the SIM slot
   that is currently active.
2. Operator clicks **Abrir WhatsApp** in the wizard. Dispatch starts
   the user, unlocks the screen, launches the activity.
3. Operator scans QR or types the SMS code on the device screen.
4. Operator clicks **Ja fiz login** in the wizard. Dispatch:
   - persists `wa_registered_profiles[uid] = phone_number` (operator
     can supply the number for clarity, optional);
   - immediately calls `POST /api/v1/devices/:serial/extract-phones-root`
     which reads the canonical phone from
     `/data/user/$UID/com.whatsapp/shared_prefs/com.whatsapp_preferences_light.xml`.
5. Operator swaps the chip to the next number and repeats for the
   next profile. Two physical chips per device, four profiles each.

## 6. Validation

End state (mirroring POCO #1):

```bash
# Users present
adb -s "$SERIAL" shell 'pm list users'

# Phones registered, per profile, per package
curl -sS -H "X-API-Key: $DISPATCH_API_KEY" \
  -X POST "http://127.0.0.1:8080/api/v1/devices/$SERIAL/extract-phones-root" \
  | jq '.results[] | {profile_id, package_name, phone}'

# Chips visible in the UI
# Open /admin/frota -> Chips tab -> filter by device serial.
```

The wizard's final step (`POST /setup/finalize`) re-runs the extractor
and reports `phones_persisted` + `chips_created`.

## 7. Recovery

| Symptom | Fix |
|---|---|
| Profile shows "Setup Wizard incomplete" forever | Re-run the bypass endpoint with `force: true`. |
| `extract-phones-root` returns `wa_not_initialized` for a profile | The data dir does not exist yet. Run launch-wa once and have the operator log in. |
| Chip table shows duplicates | `chipRegistry.importFromDevices()` deduplicates by `(device_serial, profile_id, package_name)`. Run again, then refresh the UI. |
| Wizard state is stale (operator wants to start over) | `POST /api/v1/devices/:serial/setup/reset` (audit-logged). |

## 8. Reference: schema

`device_setup_wizard_state` (created by `SetupWizardStore.initialize()`):

| Column | Type | Notes |
|---|---|---|
| `device_serial` | TEXT PRIMARY KEY | one row per device |
| `root_done` | INTEGER 0/1 | persisted root probe outcome |
| `users_created_json` | TEXT | `{ "11": "Oralsin 1 1", ... }` |
| `bypassed_profiles_json` | TEXT | `{ "11": "<ISO timestamp>" }` |
| `wa_installed_profiles_json` | TEXT | `{ "11": ["com.whatsapp"] }` |
| `wa_registered_profiles_json` | TEXT | `{ "11": "+5543991938235" }` |
| `extraction_complete` | INTEGER 0/1 | true after `POST /setup/finalize` |
| `current_step` | TEXT | last completed sub-step |
| `started_at`, `updated_at`, `finished_at` | TEXT | ISO-8601 |

Idempotent UPSERT keyed on `device_serial`. JSON columns merge shallow:
a partial update of one profile does not wipe siblings.
