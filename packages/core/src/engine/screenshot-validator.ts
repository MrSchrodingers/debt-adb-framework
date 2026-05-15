export interface ValidationResult {
  /**
   * Authoritative answer. `true` requires positive proof of delivery:
   * the message body appears as a bubble in the conversation, OR a
   * tick/status indicator is visible (and no dialog blocks send).
   */
  valid: boolean
  reason: string
  /** Strong positive: the message body text appears in a conversation node (not the input field). */
  bodyMessageVisible: boolean
  /** Medium positive: tick/status/message_text node visible somewhere on screen. */
  lastMessageVisible: boolean
  /** Chat input field is present on screen. */
  chatInputFound: boolean
  /**
   * Chat input still contains body text. Used for diagnostics only —
   * w4b retains the typed text after a successful send on some
   * Android builds, so this signal alone does NOT mean the send failed.
   */
  chatInputHasBodyText: boolean
  /** Negative: an error/permission dialog is present (Erro/Permitir/Confiar/...). */
  dialogDetected: boolean
}

/**
 * Post-send UI state validator.
 *
 * Decides whether a tapSendButton actually delivered the message by analysing
 * the UIAutomator XML dump captured ~2s after the tap. The result is
 * authoritative — SendEngine throws PostSendValidationError when valid=false
 * so the orchestrator can re-enqueue (without WAHA fallback) instead of
 * silently marking the message as `sent` while the body is still sitting in
 * the chat input or a dialog blocked send.
 *
 * Lessons from prod incident 2026-05-15:
 *  - WhatsApp Business (com.whatsapp.w4b) DOES NOT auto-clear the chat input
 *    after a successful send. The typed body remains visible in
 *    `com.whatsapp.w4b:id/entry` even though the bubble is already in the
 *    conversation. So "input has body text" is NOT a reliable failure signal.
 *  - The only authoritative positive proof of delivery is the body text
 *    appearing in a conversation-layer node (typically `message_text` inside
 *    `conversation_text_row`). When `messageBody` is provided, the validator
 *    looks for that specific string outside the input field.
 *  - Tick/status indicators are a weaker positive (some indicators belong to
 *    previous messages), but they confirm the conversation is in a healthy
 *    post-send state.
 */
export class ScreenshotValidator {
  /**
   * @param uiXml — UIAutomator XML dump captured ~2s after tapping send.
   * @param appPackage — Android package targeted (default: com.whatsapp).
   *   `com.whatsapp.w4b` exposes its own resource-id namespace.
   * @param messageBody — Optional. When provided, the validator searches for
   *   this exact text in conversation-layer nodes (outside the input field)
   *   as the strongest proof of delivery.
   */
  validate(uiXml: string, appPackage = 'com.whatsapp', messageBody?: string): ValidationResult {
    const inputResourceIds = [
      `${appPackage}:id/entry`,
      `${appPackage}:id/text_entry_view`,
      // Defensive: some w4b views ship the legacy com.whatsapp namespace on the input.
      'com.whatsapp:id/entry',
      'com.whatsapp:id/text_entry_view',
    ]

    const chatInputFound = inputResourceIds.some((id) => uiXml.includes(id))
    const chatInputHasBodyText = chatInputFound && hasNonEmptyInputText(uiXml, inputResourceIds)

    // Strongest positive: the exact body text appears in a conversation
    // bubble (any node with text="<body>" whose resource-id is NOT the input
    // field). Only computed when the caller supplies messageBody.
    const bodyMessageVisible = messageBody
      ? bodyTextOutsideInput(uiXml, messageBody, inputResourceIds)
      : false

    // Medium positive: any conversation-layer indicator (tick / status /
    // message_text node / conversation_text_row) is present.
    const lastMessageVisible =
      uiXml.includes(`${appPackage}:id/single_tick`) ||
      uiXml.includes(`${appPackage}:id/double_tick`) ||
      uiXml.includes(`${appPackage}:id/status`) ||
      uiXml.includes(`${appPackage}:id/message_text`) ||
      uiXml.includes(`${appPackage}:id/conversation_text_row`) ||
      uiXml.includes('com.whatsapp:id/single_tick') ||
      uiXml.includes('com.whatsapp:id/double_tick') ||
      uiXml.includes('com.whatsapp:id/status') ||
      uiXml.includes('com.whatsapp:id/message_text') ||
      uiXml.includes('com.whatsapp:id/conversation_text_row')

    const dialogDetected =
      /text="[^"]*\b(Enviar para|Abrir com|Confiar|Continuar|Permitir|Erro|Error|Falha)\b[^"]*"/i.test(uiXml)

    // Authoritative decision tree.
    let valid: boolean
    let reason: string
    if (dialogDetected) {
      valid = false
      reason = 'Dialog detected after send — message may not have been delivered'
    } else if (bodyMessageVisible) {
      valid = true
      reason = 'Body text visible in conversation — delivery confirmed'
    } else if (lastMessageVisible && chatInputFound) {
      valid = true
      reason = 'Chat shows tick/message indicator — likely delivered'
    } else if (!chatInputFound) {
      valid = false
      reason = 'Chat input not found — may be stuck on dialog or wrong screen'
    } else {
      valid = false
      reason = 'No delivery signal detected — message likely not sent'
    }

    return {
      valid,
      reason,
      bodyMessageVisible,
      lastMessageVisible,
      chatInputFound,
      chatInputHasBodyText,
      dialogDetected,
    }
  }
}

/**
 * True iff the chat input field's `text="..."` attribute is non-empty.
 * Diagnostic-only — not used in the valid decision because w4b retains
 * the typed body after a successful send.
 */
function hasNonEmptyInputText(uiXml: string, resourceIds: readonly string[]): boolean {
  for (const id of resourceIds) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`<node[^>]*\\bresource-id="${escaped}"[^>]*\\btext="([^"]+)"`, 'i')
    if (re.test(uiXml)) return true
    const re2 = new RegExp(`<node[^>]*\\btext="([^"]+)"[^>]*\\bresource-id="${escaped}"`, 'i')
    if (re2.test(uiXml)) return true
  }
  return false
}

/**
 * Strong positive proof of delivery: the exact `body` text appears in at least
 * one `<node ... text="<body>" ...>` whose resource-id is NOT one of the
 * input-field ids. Walks every matching node via `matchAll` rather than the
 * stateful regex exec form.
 */
function bodyTextOutsideInput(uiXml: string, body: string, inputResourceIds: readonly string[]): boolean {
  const escapedBody = body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Match every `<node ...>` opening tag that contains `text="<body>"`.
  // Use [^>]*? (not [^/>]) because resource-ids contain `/`
  // (`com.whatsapp:id/message_text`). The trailing `[^>]*` swallows the
  // remaining attributes up to `>` regardless of self-closing form.
  const nodeRe = new RegExp(`<node\\b([^>]*?\\btext="${escapedBody}"[^>]*)>`, 'g')

  for (const match of uiXml.matchAll(nodeRe)) {
    const attrs = match[1] ?? ''
    const ridMatch = attrs.match(/\bresource-id="([^"]*)"/)
    const rid = ridMatch?.[1] ?? ''
    if (!inputResourceIds.includes(rid)) {
      return true
    }
  }
  return false
}
