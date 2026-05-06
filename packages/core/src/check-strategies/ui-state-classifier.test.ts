import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { classifyUiState } from './ui-state-classifier.js'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'ui-states')
const FIX = (name: string) => readFileSync(join(FIXTURES_DIR, name), 'utf8')

describe('classifyUiState — smoke', () => {
  it('returns unknown for empty XML', () => {
    const r = classifyUiState({ xml: '' })
    expect(r.state).toBe('unknown')
    expect(r.decisive).toBe(false)
    expect(r.retryable).toBe(true)
  })
})

describe('classifyUiState — chat_open', () => {
  it('input field via resource-id (real device fixture)', () => {
    const r = classifyUiState({ xml: FIX('chat_open_input.xml') })
    expect(r.state).toBe('chat_open')
    expect(r.decisive).toBe(true)
    expect(r.retryable).toBe(false)
  })

  it('input field via EditText fallback', () => {
    const xml = `<hierarchy><node class="android.widget.EditText" package="com.whatsapp" /></hierarchy>`
    expect(classifyUiState({ xml }).state).toBe('chat_open')
  })
})

describe('classifyUiState — searching', () => {
  it('progress_bar id (synthesized fixture)', () => {
    const r = classifyUiState({ xml: FIX('searching_spinner.xml') })
    expect(r.state).toBe('searching')
    expect(r.decisive).toBe(false)
    expect(r.retryable).toBe(false) // searching is "wait, do not retry"
  })

  it('Pesquisando text without progress_bar id', () => {
    const xml = `<hierarchy><node text="Pesquisando..."/></hierarchy>`
    expect(classifyUiState({ xml }).state).toBe('searching')
  })

  it('English "Loading" text', () => {
    const xml = `<hierarchy><node text="Loading"/></hierarchy>`
    expect(classifyUiState({ xml }).state).toBe('searching')
  })
})

describe('classifyUiState — invite_modal', () => {
  it('pt-BR — "não está no WhatsApp" (real device fixture)', () => {
    const r = classifyUiState({ xml: FIX('invite_modal_pt_br.xml') })
    expect(r.state).toBe('invite_modal')
    expect(r.decisive).toBe(true)
    expect(r.retryable).toBe(false)
    expect(r.evidence.matched_rule).toMatch(/not_on_whatsapp_pt|invite_button_localized/)
  })

  it('EN — "not on WhatsApp" (synthesized fixture)', () => {
    const r = classifyUiState({ xml: FIX('invite_modal_en.xml') })
    expect(r.state).toBe('invite_modal')
  })

  it('legacy invite_cta resource-id', () => {
    const xml = `<hierarchy><node resource-id="com.whatsapp:id/invite_cta" /></hierarchy>`
    const r = classifyUiState({ xml })
    expect(r.state).toBe('invite_modal')
    expect(r.evidence.matched_rule).toBe('whatsapp_invite_cta_id')
  })

  it('Spanish — "no está en WhatsApp"', () => {
    const xml = `<hierarchy><node text="El número no está en WhatsApp" resource-id="android:id/message" /></hierarchy>`
    expect(classifyUiState({ xml }).state).toBe('invite_modal')
  })

  it('localized invite button (Portuguese)', () => {
    const xml = `<hierarchy><node text="Convidar para o WhatsApp" resource-id="android:id/button1" /></hierarchy>`
    expect(classifyUiState({ xml }).state).toBe('invite_modal')
  })
})

describe('classifyUiState — wrong screens', () => {
  it('disappearing_msg_dialog (synthesized fixture)', () => {
    const r = classifyUiState({ xml: FIX('disappearing_msg_dialog.xml') })
    expect(r.state).toBe('disappearing_msg_dialog')
    expect(r.decisive).toBe(false)
    expect(r.retryable).toBe(true)
    expect(r.evidence.matched_rule).toBe('disappearing_messages_modal')
  })

  it('contact_picker via topActivity', () => {
    const r = classifyUiState({
      xml: '<hierarchy/>',
      topActivity: 'com.whatsapp/.contact.ui.picker.ContactPicker',
    })
    expect(r.state).toBe('contact_picker')
    expect(r.evidence.matched_rule).toBe('top_activity_contact_picker')
  })

  it('contact_picker via xml hint (synthesized fixture)', () => {
    const r = classifyUiState({ xml: FIX('contact_picker.xml') })
    expect(r.state).toBe('contact_picker')
    expect(r.evidence.matched_rule).toBe('contact_row_repeated')
  })

  it('chat_list via repeated conversations_row markers (real device fixture)', () => {
    const r = classifyUiState({ xml: FIX('chat_list_full.xml') })
    expect(r.state).toBe('chat_list')
    expect(r.decisive).toBe(false)
    expect(r.retryable).toBe(true)
    expect(r.evidence.matched_rule).toBe('conversations_row_repeated')
  })

  it('chat_list via bottom-nav tabs (synthesized inline)', () => {
    const xml = `<hierarchy>
      <node resource-id="com.whatsapp:id/tabs_root">
        <node text="Conversas" />
        <node text="Atualizações" />
        <node text="Chamadas" />
      </node>
    </hierarchy>`
    expect(classifyUiState({ xml }).state).toBe('chat_list')
  })
})

describe('classifyUiState — unknown branches', () => {
  it('unknown_dialog when modal markers but no known text (synthesized fixture)', () => {
    const r = classifyUiState({ xml: FIX('unknown_dialog_generic.xml') })
    expect(r.state).toBe('unknown_dialog')
    expect(r.evidence.has_message_box).toBe(true)
    expect(r.retryable).toBe(true)
  })

  it('unknown when nothing matches (synthesized fixture)', () => {
    const r = classifyUiState({ xml: FIX('unknown_blank.xml') })
    expect(r.state).toBe('unknown')
    expect(r.retryable).toBe(true)
    expect(r.evidence.matched_rule).toBe('fallback_no_rule_matched')
  })

  it('unknown_dialog when only buttons present (no message box)', () => {
    const xml = `<hierarchy><node resource-id="android:id/button1" /><node resource-id="android:id/button2" /></hierarchy>`
    const r = classifyUiState({ xml })
    expect(r.state).toBe('unknown_dialog')
    expect(r.evidence.has_modal_buttons).toBe(true)
    expect(r.evidence.has_message_box).toBe(false)
  })
})
