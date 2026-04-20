import type { AdbShellAdapter } from '../monitor/types.js'
import type { CheckStrategy, StrategyResult, CheckContext } from './types.js'

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

    const started = Date.now()
    await this.adb.shell(
      deviceSerial,
      `am start -a android.intent.action.VIEW -d "https://wa.me/${variant}" -p com.whatsapp`,
    )
    await this.delay(4000)
    await this.adb.shell(deviceSerial, 'uiautomator dump /sdcard/dispatch-probe.xml')
    const xml = await this.adb.shell(deviceSerial, 'cat /sdcard/dispatch-probe.xml')

    const hasInputField =
      /resource-id="com\.whatsapp:id\/(entry|conversation_entry|text_entry)"/.test(xml) ||
      (/class="android\.widget\.EditText"/.test(xml) && /com\.whatsapp/.test(xml))
    const hasInviteCta =
      /resource-id="com\.whatsapp:id\/invite_cta"/.test(xml) ||
      /Convidar|invite to WhatsApp|not on WhatsApp/i.test(xml)

    const latency_ms = Date.now() - started

    if (hasInputField) {
      return {
        source: this.source,
        result: 'exists',
        confidence: 0.95,
        evidence: { has_input_field: true, ui_dump_length: xml.length },
        latency_ms,
        variant_tried: variant,
        device_serial: deviceSerial,
      }
    }
    if (hasInviteCta) {
      return {
        source: this.source,
        result: 'not_exists',
        confidence: 0.95,
        evidence: { has_invite_cta: true, ui_dump_length: xml.length },
        latency_ms,
        variant_tried: variant,
        device_serial: deviceSerial,
      }
    }
    return {
      source: this.source,
      result: 'inconclusive',
      confidence: null,
      evidence: { has_input_field: false, has_invite_cta: false, ui_dump_length: xml.length },
      latency_ms,
      variant_tried: variant,
      device_serial: deviceSerial,
    }
  }
}
