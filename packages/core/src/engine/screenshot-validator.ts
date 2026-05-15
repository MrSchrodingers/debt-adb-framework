export interface ValidationResult {
  valid: boolean
  reason: string
  chatInputFound: boolean
  dialogDetected: boolean
  lastMessageVisible: boolean
  /** True when chat input exists AND still contains body text (send didn't fire). */
  chatInputHasBodyText?: boolean
}

/**
 * Post-send UI state validator.
 *
 * Analyses the UIAutomator XML dump captured AFTER tapSendButton() to determine
 * whether the message likely landed in the chat.  The result is now authoritative —
 * SendEngine throws PostSendValidationError when `valid===false` so the
 * orchestrator can re-enqueue (without the WAHA fallback) instead of silently
 * marking the message as `sent` while the body is still sitting in the input.
 *
 * Why XML instead of pixel comparison?
 *  - No native-module dependency (sharp/canvas not required)
 *  - Deterministic string matching vs. fragile image thresholds
 *  - Works identically across screen densities and device models
 */
export class ScreenshotValidator {
  /**
   * Validate that the send was successful by checking UI state.
   * Uses the XML dump (already captured by dumpUi) rather than pixel comparison.
   *
   * @param uiXml — UIAutomator XML dump captured ~2s after tapping send.
   * @param appPackage — Android package the send targeted. Defaults to
   *   `com.whatsapp`. WhatsApp Business exposes its own resource-id namespace
   *   (`com.whatsapp.w4b:id/...`); this parameter ensures the matchers track
   *   the correct prefix without losing backwards compatibility with the
   *   default namespace.
   */
  validate(uiXml: string, appPackage = 'com.whatsapp'): ValidationResult {
    const inputResourceIds = [
      `${appPackage}:id/entry`,
      `${appPackage}:id/text_entry_view`,
      // Defensive fallback: some w4b views still use the legacy com.whatsapp
      // namespace on the entry field even when the rest of the dump is
      // namespaced. Accept both so we don't bounce through unnecessary
      // recovery on those mixed views.
      'com.whatsapp:id/entry',
      'com.whatsapp:id/text_entry_view',
    ]

    const chatInputFound = inputResourceIds.some((id) => uiXml.includes(id))

    // Detect "input field still holds body text" — strongest signal that the
    // tap on send did NOT deliver. Matches the input node and inspects its
    // `text="..."` attribute; non-empty means the message stayed in the field.
    const chatInputHasBodyText = chatInputFound && hasNonEmptyInputText(uiXml, inputResourceIds)

    // Check for error/dialog indicators that should have been dismissed pre-send.
    // Uses word-boundary-style match: the keyword can appear anywhere inside text="..."
    const dialogDetected =
      /text="[^"]*\b(Enviar para|Abrir com|Confiar|Continuar|Permitir|Erro|Error|Falha)\b[^"]*"/i.test(uiXml)

    // Check for sent message indicators (checkmarks, message text nodes).
    // These live on the conversation list/thread, not the input — namespace
    // here can be either com.whatsapp or com.whatsapp.w4b.
    const lastMessageVisible =
      uiXml.includes(`${appPackage}:id/single_tick`) ||
      uiXml.includes(`${appPackage}:id/double_tick`) ||
      uiXml.includes(`${appPackage}:id/status`) ||
      uiXml.includes(`${appPackage}:id/message_text`) ||
      uiXml.includes('com.whatsapp:id/single_tick') ||
      uiXml.includes('com.whatsapp:id/double_tick') ||
      uiXml.includes('com.whatsapp:id/status') ||
      uiXml.includes('com.whatsapp:id/message_text')

    const valid = chatInputFound && !dialogDetected && !chatInputHasBodyText

    const reason = chatInputHasBodyText
      ? 'Chat input still has body text — send tap did not deliver'
      : !chatInputFound
        ? 'Chat input not found — may be stuck on dialog'
        : dialogDetected
          ? 'Dialog detected after send — message may not have been delivered'
          : 'Chat appears healthy'

    return { valid, reason, chatInputFound, dialogDetected, lastMessageVisible, chatInputHasBodyText }
  }
}

/**
 * Returns true when at least one of the input resource-ids appears on a node
 * whose `text="..."` attribute is non-empty. Empty-string text is treated as
 * "no body present" (the post-send happy path).
 *
 * Implementation note: UIAutomator emits attributes in a stable order
 * (resource-id before text), so a regex that captures everything up to the
 * next `text="..."` within the same `<node ...>` opening tag is reliable.
 */
function hasNonEmptyInputText(uiXml: string, resourceIds: readonly string[]): boolean {
  for (const id of resourceIds) {
    // Match the entire opening tag of any <node ... resource-id="<id>" ...>
    // and look for `text="<one or more chars>"` inside it.
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`<node[^>]*\\bresource-id="${escaped}"[^>]*\\btext="([^"]+)"`, 'i')
    if (re.test(uiXml)) return true
    // Also handle attribute order variation: text="..." before resource-id="..."
    const re2 = new RegExp(`<node[^>]*\\btext="([^"]+)"[^>]*\\bresource-id="${escaped}"`, 'i')
    if (re2.test(uiXml)) return true
  }
  return false
}
