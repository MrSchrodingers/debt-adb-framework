import { describe, it, expect } from 'vitest'
import { ScreenshotValidator } from './screenshot-validator.js'

describe('ScreenshotValidator', () => {
  const validator = new ScreenshotValidator()

  describe('validate()', () => {
    it('validates healthy chat state with chat input + last message indicator', () => {
      const xml = `<hierarchy>
        <node resource-id="com.whatsapp:id/entry" bounds="[50,1400][850,1500]" />
        <node resource-id="com.whatsapp:id/send" bounds="[900,1600][1000,1700]" />
        <node resource-id="com.whatsapp:id/message_text" text="Hello" />
      </hierarchy>`

      const result = validator.validate(xml)

      expect(result.valid).toBe(true)
      expect(result.chatInputFound).toBe(true)
      expect(result.dialogDetected).toBe(false)
      expect(result.lastMessageVisible).toBe(true)
      expect(result.reason).toContain('tick/message indicator')
    })

    it('detects missing chat input — may be stuck on dialog or wrong screen', () => {
      const xml = `<hierarchy>
        <node resource-id="com.whatsapp:id/conversations_row" />
        <node text="Chats" />
      </hierarchy>`

      const result = validator.validate(xml)

      expect(result.valid).toBe(false)
      expect(result.chatInputFound).toBe(false)
      expect(result.reason).toContain('Chat input not found')
    })

    it('detects lingering "Enviar para" dialog after send', () => {
      const xml = `<hierarchy>
        <node resource-id="com.whatsapp:id/entry" bounds="[50,1400][850,1500]" />
        <node text="Enviar para" bounds="[50,50][500,100]" />
      </hierarchy>`

      const result = validator.validate(xml)

      expect(result.valid).toBe(false)
      expect(result.dialogDetected).toBe(true)
      expect(result.chatInputFound).toBe(true)
      expect(result.reason).toContain('Dialog detected after send')
    })

    it('detects lingering "Erro" dialog after send', () => {
      const xml = `<hierarchy>
        <node resource-id="com.whatsapp:id/entry" bounds="[50,1400][850,1500]" />
        <node text="Erro ao enviar" />
      </hierarchy>`

      const result = validator.validate(xml)

      expect(result.valid).toBe(false)
      expect(result.dialogDetected).toBe(true)
    })

    it('detects "Continuar" dialog still present', () => {
      const xml = `<hierarchy>
        <node text="Continuar" bounds="[200,800][500,860]" />
      </hierarchy>`

      const result = validator.validate(xml)

      expect(result.valid).toBe(false)
      expect(result.chatInputFound).toBe(false)
      expect(result.dialogDetected).toBe(true)
    })

    it('detects "Permitir" permission dialog still present', () => {
      const xml = `<hierarchy>
        <node resource-id="com.whatsapp:id/text_entry_view" />
        <node text="Permitir" bounds="[300,900][500,960]" />
      </hierarchy>`

      const result = validator.validate(xml)

      expect(result.valid).toBe(false)
      expect(result.dialogDetected).toBe(true)
      expect(result.chatInputFound).toBe(true)
    })

    it('handles empty XML gracefully', () => {
      const result = validator.validate('')

      expect(result.valid).toBe(false)
      expect(result.chatInputFound).toBe(false)
      expect(result.dialogDetected).toBe(false)
      expect(result.lastMessageVisible).toBe(false)
      expect(result.reason).toContain('Chat input not found')
    })

    it('recognizes alternative chat input resource ID (text_entry_view) + tick = valid', () => {
      const xml = `<hierarchy>
        <node resource-id="com.whatsapp:id/text_entry_view" bounds="[50,1400][850,1500]" />
        <node resource-id="com.whatsapp:id/double_tick" />
      </hierarchy>`

      const result = validator.validate(xml)

      expect(result.valid).toBe(true)
      expect(result.chatInputFound).toBe(true)
    })

    it('detects sent message via single_tick (pending)', () => {
      const xml = `<hierarchy>
        <node resource-id="com.whatsapp:id/entry" bounds="[50,1400][850,1500]" />
        <node resource-id="com.whatsapp:id/single_tick" />
      </hierarchy>`

      const result = validator.validate(xml)

      expect(result.valid).toBe(true)
      expect(result.lastMessageVisible).toBe(true)
    })

    it('detects sent message via double_tick (delivered)', () => {
      const xml = `<hierarchy>
        <node resource-id="com.whatsapp:id/entry" bounds="[50,1400][850,1500]" />
        <node resource-id="com.whatsapp:id/double_tick" />
      </hierarchy>`

      const result = validator.validate(xml)

      expect(result.valid).toBe(true)
      expect(result.lastMessageVisible).toBe(true)
    })

    it('reports valid=false when chat input present but NO delivery signal (no tick, no body match)', () => {
      // Tightened post-2026-05-15: input alone is not enough; we need
      // positive proof of delivery (body in conversation OR tick).
      const xml = `<hierarchy>
        <node resource-id="com.whatsapp:id/entry" bounds="[50,1400][850,1500]" />
      </hierarchy>`

      const result = validator.validate(xml)

      expect(result.valid).toBe(false)
      expect(result.lastMessageVisible).toBe(false)
      expect(result.reason).toContain('No delivery signal')
    })

    it('dialog detection is case-insensitive', () => {
      const xml = `<hierarchy>
        <node resource-id="com.whatsapp:id/entry" />
        <node text="ERRO" />
      </hierarchy>`

      const result = validator.validate(xml)

      expect(result.valid).toBe(false)
      expect(result.dialogDetected).toBe(true)
    })

    // ────────────────────────────────────────────────────────────────────
    // Bug found 2026-05-15 in prod:
    //  (a) w4b namespace (com.whatsapp.w4b:id/entry) wasn't recognised,
    //      every w4b send reported "Chat input not found" even when the
    //      dump clearly showed an input field.
    //  (b) input-with-body-text was reported as "Chat appears healthy" —
    //      meaning the body was sitting un-sent in the field but the
    //      validator said the send succeeded.
    // ────────────────────────────────────────────────────────────────────

    it('recognises chat input on com.whatsapp.w4b namespace (Business)', () => {
      const xml = `<hierarchy>
        <node resource-id="com.whatsapp.w4b:id/entry" text="" bounds="[50,1400][850,1500]" />
        <node resource-id="com.whatsapp.w4b:id/message_text" text="prior msg" />
      </hierarchy>`

      const result = validator.validate(xml, 'com.whatsapp.w4b')

      expect(result.chatInputFound).toBe(true)
      expect(result.lastMessageVisible).toBe(true)
      expect(result.valid).toBe(true)
    })

    it('STRONG positive: messageBody visible in conversation bubble = valid', () => {
      // Real shape from a03 w4b dump 2026-05-15. The body text appears in a
      // message_text node (bubble) AND lingers in the input field. The
      // validator MUST accept this as delivered.
      const xml = `<hierarchy>
        <node resource-id="com.whatsapp.w4b:id/conversation_text_row" />
        <node resource-id="com.whatsapp.w4b:id/message_text" text="FIX5-W4B 15:24:02" />
        <node resource-id="com.whatsapp.w4b:id/entry" text="FIX5-W4B 15:24:02" />
      </hierarchy>`

      const result = validator.validate(xml, 'com.whatsapp.w4b', 'FIX5-W4B 15:24:02')

      expect(result.bodyMessageVisible).toBe(true)
      expect(result.chatInputHasBodyText).toBe(true)
      expect(result.valid).toBe(true)
      expect(result.reason).toContain('delivery confirmed')
    })

    it('FAIL: body NOT in conversation AND input lingers + no tick = not delivered', () => {
      // The body was typed into the input but tapSendButton missed: no
      // bubble in the conversation, no tick. Permanently failed.
      const xml = `<hierarchy>
        <node resource-id="com.whatsapp.w4b:id/entry" text="NOT_SENT_TEST" bounds="[50,1400][850,1500]" />
      </hierarchy>`

      const result = validator.validate(xml, 'com.whatsapp.w4b', 'NOT_SENT_TEST')

      expect(result.bodyMessageVisible).toBe(false)
      expect(result.lastMessageVisible).toBe(false)
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('No delivery signal')
    })

    it('FALLBACK: no body match but tick + chat input visible = valid', () => {
      // Caller passed body but it had emojis / line breaks that escape match.
      // Falls back to lastMessageVisible signal.
      const xml = `<hierarchy>
        <node resource-id="com.whatsapp.w4b:id/entry" text="" />
        <node resource-id="com.whatsapp.w4b:id/single_tick" />
      </hierarchy>`

      const result = validator.validate(xml, 'com.whatsapp.w4b', '👋 Olá!')

      expect(result.bodyMessageVisible).toBe(false)
      expect(result.lastMessageVisible).toBe(true)
      expect(result.valid).toBe(true)
      expect(result.reason).toContain('tick/message indicator')
    })

    it('Dialog blocks send even when body matches in conversation', () => {
      const xml = `<hierarchy>
        <node resource-id="com.whatsapp.w4b:id/message_text" text="OK BODY" />
        <node resource-id="com.whatsapp.w4b:id/entry" text="OK BODY" />
        <node text="Erro ao enviar" />
      </hierarchy>`

      const result = validator.validate(xml, 'com.whatsapp.w4b', 'OK BODY')

      expect(result.dialogDetected).toBe(true)
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('Dialog detected')
    })

    it('com.whatsapp default namespace: body in bubble + chat input cleared = valid', () => {
      const xml = `<hierarchy>
        <node resource-id="com.whatsapp:id/message_text" text="Olá mundo" />
        <node resource-id="com.whatsapp:id/entry" text="" />
      </hierarchy>`

      const result = validator.validate(xml, 'com.whatsapp', 'Olá mundo')

      expect(result.bodyMessageVisible).toBe(true)
      expect(result.valid).toBe(true)
    })
  })
})
