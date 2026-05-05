import type { AdbShellAdapter } from '../monitor/types.js'
import type { CheckStrategy, StrategyResult, CheckContext } from './types.js'

/**
 * Optional shared lock taker for the device. Injected from `engine`
 * (DeviceMutex) so the probe waits for the WorkerOrchestrator to
 * finish whatever it is sending before issuing a new wa.me intent on
 * the same screen — without this coordination the intent fires
 * mid-typing and WhatsApp moves the half-typed message into the
 * previous chat's draft.
 */
export interface DeviceLockTaker {
  acquire(deviceSerial: string): Promise<() => void>
}

/**
 * ADB UIAutomator probe — primary source of truth per grill D2.
 * Opens wa.me/<variant> via intent; checks UI dump for presence of
 * WhatsApp chat EditText (exists) vs invite-CTA (not_exists).
 * Never queries WhatsApp server → zero ban risk.
 */
export class AdbProbeStrategy implements CheckStrategy {
  readonly source = 'adb_probe' as const

  constructor(
    private adb: AdbShellAdapter,
    private delay: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
    /**
     * Pass the same DeviceMutex instance the WorkerOrchestrator uses.
     * Optional — when omitted the probe runs without device-level
     * coordination (legacy behaviour, kept for tests).
     */
    private deviceMutex?: DeviceLockTaker,
  ) {}

  available(): boolean {
    return true
  }

  async probe(variant: string, ctx: CheckContext = {}): Promise<StrategyResult> {
    const deviceSerial = ctx.deviceSerial
    if (!deviceSerial) {
      throw new Error('AdbProbeStrategy: deviceSerial is required in context')
    }
    if (!/^\d{12,13}$/.test(variant)) {
      throw new Error(`AdbProbeStrategy: unsafe variant "${variant}"`)
    }
    if (ctx.profileId !== undefined && (!Number.isInteger(ctx.profileId) || ctx.profileId < 0)) {
      throw new Error(`AdbProbeStrategy: invalid profileId "${ctx.profileId}"`)
    }

    const started = Date.now()
    const timeoutMs = ctx.timeoutMs ?? 15_000
    const deadline = started + timeoutMs

    // Acquire the shared device lock BEFORE issuing the intent.
    // Without it a probe can fire `am start ... wa.me/X` while the
    // worker is mid-`input text`, and WhatsApp moves the half-typed
    // body into the previous chat's draft — that is the source of
    // the dozens of "rascunho" Oralsin messages reported in the
    // field. The release is in a finally so a thrown probe always
    // unblocks the worker.
    const release = this.deviceMutex
      ? await this.deviceMutex.acquire(deviceSerial)
      : () => {}
    try {
      // Route the wa.me intent to the WhatsApp instance of the
      // requested Android user when the caller specified one. Without
      // `--user N` Android sends the intent to whichever user is in
      // foreground — typically profile 0 — and the probe answers for
      // the wrong account, so picking a different sender in the UI had
      // no effect on the actual probe target. `--user` is integer-only
      // so the regex above prevents shell injection by construction.
      const userArg = ctx.profileId !== undefined ? `--user ${ctx.profileId} ` : ''
      await this.adb.shell(
        deviceSerial,
        `am start ${userArg}-a android.intent.action.VIEW -d "https://wa.me/${variant}" -p com.whatsapp`,
      )
      // Give WA a moment to render the intent result before the first UI dump.
      await this.delay(1500)

      let xml = ''
      let pollCount = 0
      let sawSearching = false
      const pollIntervalMs = 1000

      // Poll until we reach a terminal UI state (chat entry or invite CTA) or the
      // timeout fires. Required because WhatsApp shows an intermediate
      // "Pesquisando.../Searching..." screen while it resolves the number against
      // the server — the old single-shot 4s wait often caught this transient
      // state and returned inconclusive, counting valid numbers as errors.
      while (Date.now() < deadline) {
        await this.adb.shell(deviceSerial, 'uiautomator dump /sdcard/dispatch-probe.xml')
        xml = await this.adb.shell(deviceSerial, 'cat /sdcard/dispatch-probe.xml')
        pollCount++

        const hasInputField =
          /resource-id="com\.whatsapp:id\/(entry|conversation_entry|text_entry)"/.test(xml) ||
          (/class="android\.widget\.EditText"/.test(xml) && /com\.whatsapp/.test(xml))
        const hasInviteCta =
          /resource-id="com\.whatsapp:id\/invite_cta"/.test(xml) ||
          /Convidar|invite to WhatsApp|not on WhatsApp/i.test(xml)
        const isSearching =
          /Pesquisando|Searching|Procurando|Cargando|Loading/i.test(xml) ||
          /resource-id="com\.whatsapp:id\/progress_bar"/.test(xml)

        if (hasInputField) {
          return {
            source: this.source,
            result: 'exists',
            confidence: 0.95,
            evidence: { has_input_field: true, ui_dump_length: xml.length, polls: pollCount },
            latency_ms: Date.now() - started,
            variant_tried: variant,
            device_serial: deviceSerial,
          }
        }
        if (hasInviteCta) {
          return {
            source: this.source,
            result: 'not_exists',
            confidence: 0.95,
            evidence: { has_invite_cta: true, ui_dump_length: xml.length, polls: pollCount },
            latency_ms: Date.now() - started,
            variant_tried: variant,
            device_serial: deviceSerial,
          }
        }
        if (isSearching) {
          sawSearching = true
        }
        await this.delay(pollIntervalMs)
      }

      return {
        source: this.source,
        result: 'inconclusive',
        confidence: null,
        evidence: {
          has_input_field: false,
          has_invite_cta: false,
          saw_searching: sawSearching,
          timed_out: true,
          polls: pollCount,
          ui_dump_length: xml.length,
        },
        latency_ms: Date.now() - started,
        variant_tried: variant,
        device_serial: deviceSerial,
      }
    } finally {
      release()
    }
  }
}
