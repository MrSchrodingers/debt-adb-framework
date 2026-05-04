import type Database from 'better-sqlite3'
import type { ManagedSessions } from './managed-sessions.js'

/**
 * Resolves `managed_sessions.device_serial + profile_id` automatically
 * by matching `managed_sessions.phone_number` (the number WAHA already
 * knows) against `whatsapp_accounts.phone_number` (the truth scanned
 * from the device's shared_prefs via root).
 *
 * Why this exists: the device-side scanner already discovers which
 * Android user holds which WhatsApp number on every connected device.
 * Asking the operator to manually point a finger from the UI is
 * redundant — the source of truth is right there. This auto-attacher
 * runs at boot and after every `mapAllAccounts` cycle so any newly
 * online device's accounts immediately wire themselves into the
 * sessions that mention the same number.
 *
 * Manual pairing remains available for sessions whose `phoneNumber`
 * is null (fresh, never paired) — those genuinely need the operator
 * to pick a vacant profile.
 */
export class ManagedSessionAutoAttacher {
  constructor(
    private readonly managedSessions: ManagedSessions,
    private readonly db: Database.Database,
  ) {}

  /**
   * Sweep all managed sessions that have a known phoneNumber but no
   * device attachment yet, and attach each one to whichever
   * (device, profile) currently holds that number.
   *
   * The match tolerates the BR 9-prefix drift: WAHA usually returns
   * a 12-digit number (e.g. `554396835104`), shared_prefs returns 13
   * (e.g. `5543996835104` after normalization). Comparing the
   * digits-only suffix handles both directions.
   *
   * Returns `{ matched, unresolved, alreadyAttached }`.
   */
  autoAttachAll(): { matched: number; unresolved: number; alreadyAttached: number } {
    const sessions = this.managedSessions.listManaged()
    const accounts = this.db
      .prepare(
        `SELECT device_serial, profile_id, package_name, phone_number
           FROM whatsapp_accounts
          WHERE phone_number IS NOT NULL AND phone_number != ''`,
      )
      .all() as Array<{
        device_serial: string
        profile_id: number
        package_name: string
        phone_number: string
      }>

    let matched = 0
    let unresolved = 0
    let alreadyAttached = 0

    for (const s of sessions) {
      if (s.deviceSerial) {
        alreadyAttached++
        continue
      }
      if (!s.phoneNumber) {
        // No phone yet → fresh session waiting for QR. Manual attach
        // path remains the answer here.
        unresolved++
        continue
      }
      const sessDigits = s.phoneNumber.replace(/\D/g, '')
      const acc = accounts.find((a) => {
        const accDigits = a.phone_number.replace(/\D/g, '')
        return (
          accDigits === sessDigits ||
          accDigits.endsWith(sessDigits) ||
          sessDigits.endsWith(accDigits)
        )
      })
      if (acc) {
        try {
          this.managedSessions.attachToDevice(s.sessionName, acc.device_serial, acc.profile_id)
          matched++
        } catch {
          // attach throws only if the session vanished between list
          // and attach — race that's safe to swallow.
          unresolved++
        }
      } else {
        unresolved++
      }
    }

    return { matched, unresolved, alreadyAttached }
  }
}
