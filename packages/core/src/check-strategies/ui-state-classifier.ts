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
  // Rules added incrementally in B3-B6.
  return build('unknown', 'fallback_no_rule_matched', input.xml)
}
