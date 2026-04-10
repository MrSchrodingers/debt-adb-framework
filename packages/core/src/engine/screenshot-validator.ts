export interface ValidationResult {
  valid: boolean
  reason: string
  chatInputFound: boolean
  dialogDetected: boolean
  lastMessageVisible: boolean
}

/**
 * Post-send UI state validator.
 *
 * Analyses the UIAutomator XML dump captured AFTER tapSendButton() to determine
 * whether the message likely landed in the chat.  This is observability-only —
 * it records the result in the message trace for post-mortem analysis but does
 * NOT fail the send (conservative approach).
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
   */
  validate(uiXml: string): ValidationResult {
    const chatInputFound =
      uiXml.includes('com.whatsapp:id/entry') ||
      uiXml.includes('com.whatsapp:id/text_entry_view')

    // Check for error/dialog indicators that should have been dismissed pre-send.
    // Uses word-boundary-style match: the keyword can appear anywhere inside text="..."
    const dialogDetected =
      /text="[^"]*\b(Enviar para|Abrir com|Confiar|Continuar|Permitir|Erro|Error|Falha)\b[^"]*"/i.test(uiXml)

    // Check for sent message indicators (checkmarks, message text nodes)
    const lastMessageVisible =
      uiXml.includes('com.whatsapp:id/single_tick') ||
      uiXml.includes('com.whatsapp:id/double_tick') ||
      uiXml.includes('com.whatsapp:id/status') ||
      uiXml.includes('com.whatsapp:id/message_text')

    const valid = chatInputFound && !dialogDetected

    const reason = !chatInputFound
      ? 'Chat input not found — may be stuck on dialog'
      : dialogDetected
        ? 'Dialog detected after send — message may not have been delivered'
        : 'Chat appears healthy'

    return { valid, reason, chatInputFound, dialogDetected, lastMessageVisible }
  }
}
