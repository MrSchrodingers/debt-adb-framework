export type UiState =
  | 'chat_open'
  | 'invite_modal'
  | 'searching'
  | 'chat_list'
  | 'contact_picker'
  | 'disappearing_msg_dialog'
  | 'unknown_dialog'
  | 'unknown'

export interface ClassifierInput {
  xml: string
  topActivity?: string | null
}

export interface ClassifierResult {
  state: UiState
  decisive: boolean
  retryable: boolean
  evidence: {
    matched_rule: string
    dump_length: number
    matched_text?: string
    has_modal_buttons: boolean
    has_message_box: boolean
  }
}

const DECISIVE: ReadonlySet<UiState> = new Set(['chat_open', 'invite_modal'])
const RETRYABLE: ReadonlySet<UiState> = new Set([
  'chat_list',
  'contact_picker',
  'disappearing_msg_dialog',
  'unknown_dialog',
  'unknown',
])

function build(
  state: UiState,
  matchedRule: string,
  xml: string,
  opts: { matchedText?: string } = {},
): ClassifierResult {
  return {
    state,
    decisive: DECISIVE.has(state),
    retryable: RETRYABLE.has(state),
    evidence: {
      matched_rule: matchedRule,
      dump_length: xml.length,
      matched_text: opts.matchedText,
      has_modal_buttons: /android:id\/button[12]/.test(xml),
      has_message_box: /android:id\/message/.test(xml),
    },
  }
}

export function classifyUiState(input: ClassifierInput): ClassifierResult {
  const { xml } = input

  // Rule 1: chat_open — decisive 'exists'
  // Note: the resource-id branch is unconditional; the EditText fallback is guarded
  // to exclude the contact_picker screen (which also contains an EditText for search).
  const hasChatInputId = /resource-id="com\.whatsapp:id\/(entry|conversation_entry|text_entry)"/.test(xml)
  const hasPickerSearch = /resource-id="com\.whatsapp:id\/picker_search"/.test(xml)
  if (
    hasChatInputId ||
    (!hasPickerSearch && /class="android\.widget\.EditText"/.test(xml) && /com\.whatsapp/.test(xml))
  ) {
    return build('chat_open', 'whatsapp_input_field', xml)
  }

  // Rule 2: invite_modal — decisive 'not_exists'
  // Priority order matters: this MUST run before searching, so a modal that
  // just popped up while a "Pesquisando..." spinner is still visible elsewhere
  // in the dump still classifies correctly.
  if (/resource-id="com\.whatsapp:id\/invite_cta"/.test(xml)) {
    return build('invite_modal', 'whatsapp_invite_cta_id', xml)
  }
  const notOnWaPt = /text="[^"]*não está no WhatsApp[^"]*"/i.exec(xml)
  if (notOnWaPt) {
    return build('invite_modal', 'not_on_whatsapp_pt', xml, { matchedText: notOnWaPt[0].slice(0, 200) })
  }
  const notOnWaEn = /text="[^"]*not on WhatsApp[^"]*"/i.exec(xml)
  if (notOnWaEn) {
    return build('invite_modal', 'not_on_whatsapp_en', xml, { matchedText: notOnWaEn[0].slice(0, 200) })
  }
  const notOnWaEs = /text="[^"]*no está en WhatsApp[^"]*"/i.exec(xml)
  if (notOnWaEs) {
    return build('invite_modal', 'not_on_whatsapp_es', xml, { matchedText: notOnWaEs[0].slice(0, 200) })
  }
  const inviteBtn = /text="(Convidar para o WhatsApp|Invite to WhatsApp|Invitar a WhatsApp)"/i.exec(xml)
  if (inviteBtn) {
    return build('invite_modal', 'invite_button_localized', xml, { matchedText: inviteBtn[0] })
  }

  // Rule 3: searching — transient (caller should poll again, NOT retry)
  if (/Pesquisando|Searching|Procurando|Cargando|Loading/i.test(xml)) {
    return build('searching', 'searching_text', xml)
  }
  if (/resource-id="com\.whatsapp:id\/progress_bar"/.test(xml)) {
    return build('searching', 'whatsapp_progress_bar', xml)
  }

  // Rule 4: disappearing_msg_dialog — retryable, recover via BACK keyevent
  if (
    /text="[^"]*(Mensagens temporárias|Disappearing messages|Mensajes temporales)[^"]*"/i.test(xml) &&
    /android:id\/button[12]/.test(xml)
  ) {
    return build('disappearing_msg_dialog', 'disappearing_messages_modal', xml)
  }

  // Rule 5: contact_picker — retryable, recover via force-stop
  if (input.topActivity === 'com.whatsapp/.contact.ui.picker.ContactPicker') {
    return build('contact_picker', 'top_activity_contact_picker', xml)
  }
  const contactRowMatches = xml.match(/resource-id="com\.whatsapp:id\/(contact_row|picker_search)"/g) ?? []
  if (contactRowMatches.length >= 2) {
    return build('contact_picker', 'contact_row_repeated', xml)
  }

  // Rule 6: chat_list — retryable, recover via force-stop
  const conversationRows = xml.match(/resource-id="com\.whatsapp:id\/conversations_row(_[^"]+)?"/g) ?? []
  if (conversationRows.length >= 3) {
    return build('chat_list', 'conversations_row_repeated', xml)
  }
  const hasChatsTab = /text="(Chats|Conversas)"/i.test(xml)
  const hasStatusTab = /text="(Status|Atualizações)"/i.test(xml)
  const hasCallsTab = /text="(Calls|Chamadas|Ligações)"/i.test(xml)
  const inTabsContext = /resource-id="[^"]*(tabs?_|bottom_)[^"]*"/i.test(xml)
  if (hasChatsTab && hasStatusTab && hasCallsTab && inTabsContext) {
    return build('chat_list', 'bottom_nav_tabs', xml)
  }

  return build('unknown', 'fallback_no_rule_matched', xml)
}
