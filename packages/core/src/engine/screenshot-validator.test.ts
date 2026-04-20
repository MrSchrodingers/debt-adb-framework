import { describe, it, expect } from 'vitest'
import { ScreenshotValidator } from './screenshot-validator.js'

describe('ScreenshotValidator', () => {
  const validator = new ScreenshotValidator()

  describe('validate()', () => {
    it('validates healthy chat state with chat input present', () => {
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
      expect(result.reason).toBe('Chat appears healthy')
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

    it('recognizes alternative chat input resource ID (text_entry_view)', () => {
      const xml = `<hierarchy>
        <node resource-id="com.whatsapp:id/text_entry_view" bounds="[50,1400][850,1500]" />
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

    it('reports valid=true even without visible message (input present, no dialog)', () => {
      // Message may have scrolled out of view — chat input presence is sufficient
      const xml = `<hierarchy>
        <node resource-id="com.whatsapp:id/entry" bounds="[50,1400][850,1500]" />
      </hierarchy>`

      const result = validator.validate(xml)

      expect(result.valid).toBe(true)
      expect(result.lastMessageVisible).toBe(false)
      expect(result.reason).toBe('Chat appears healthy')
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
  })
})
