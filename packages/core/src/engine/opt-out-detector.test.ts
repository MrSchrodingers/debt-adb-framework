import { describe, it, expect } from 'vitest'
import { OptOutDetector } from './opt-out-detector.js'

describe('OptOutDetector', () => {
  const detector = new OptOutDetector()

  describe('detects opt-out keywords', () => {
    it('detects "pare" (stop in Portuguese)', () => {
      const result = detector.detect('pare')
      expect(result.matched).toBe(true)
      if (result.matched) {
        expect(result.pattern).toBe('pare')
      }
    })

    it('detects "PARE" (case insensitive)', () => {
      const result = detector.detect('PARE')
      expect(result.matched).toBe(true)
      if (result.matched) {
        expect(result.pattern).toBe('pare')
      }
    })

    it('detects "não quero mais" (multi-word)', () => {
      const result = detector.detect('não quero mais receber')
      expect(result.matched).toBe(true)
      if (result.matched) {
        expect(result.pattern).toBe('não quero')
      }
    })

    it('detects "cancelar"', () => {
      const result = detector.detect('quero cancelar')
      expect(result.matched).toBe(true)
      if (result.matched) {
        expect(result.pattern).toBe('cancelar')
      }
    })

    it('detects "cancela" (without the r)', () => {
      const result = detector.detect('cancela isso')
      expect(result.matched).toBe(true)
      if (result.matched) {
        expect(result.pattern).toBe('cancelar')
      }
    })

    it('detects "me remova" (remove me)', () => {
      const result = detector.detect('me remova da lista')
      expect(result.matched).toBe(true)
      if (result.matched) {
        expect(result.pattern).toBe('me remova')
      }
    })

    it('detects "bloquear"', () => {
      const result = detector.detect('vou bloquear')
      expect(result.matched).toBe(true)
      if (result.matched) {
        expect(result.pattern).toBe('bloquear')
      }
    })

    it('detects "parar"', () => {
      const result = detector.detect('pode parar de enviar')
      expect(result.matched).toBe(true)
      if (result.matched) {
        expect(result.pattern).toBe('parar')
      }
    })

    it('detects "stop" (English)', () => {
      const result = detector.detect('stop')
      expect(result.matched).toBe(true)
      if (result.matched) {
        expect(result.pattern).toBe('stop')
      }
    })

    it('detects "sair"', () => {
      const result = detector.detect('quero sair dessa lista')
      expect(result.matched).toBe(true)
      if (result.matched) {
        expect(result.pattern).toBe('sair')
      }
    })

    it('detects "chega"', () => {
      const result = detector.detect('chega de mensagem')
      expect(result.matched).toBe(true)
      if (result.matched) {
        expect(result.pattern).toBe('chega')
      }
    })

    it('detects "denunciar"', () => {
      const result = detector.detect('vou denunciar')
      expect(result.matched).toBe(true)
      if (result.matched) {
        expect(result.pattern).toBe('denunciar')
      }
    })

    it('detects "reportar"', () => {
      const result = detector.detect('vou reportar esse numero')
      expect(result.matched).toBe(true)
      if (result.matched) {
        expect(result.pattern).toBe('reportar')
      }
    })

    it('detects "nao quero" (without accent)', () => {
      const result = detector.detect('nao quero mais')
      expect(result.matched).toBe(true)
      if (result.matched) {
        expect(result.pattern).toBe('nao quero')
      }
    })

    it('detects "não envie"', () => {
      const result = detector.detect('não envie mais mensagens')
      expect(result.matched).toBe(true)
      if (result.matched) {
        expect(result.pattern).toBe('não quero')
      }
    })

    it('detects "não mande"', () => {
      const result = detector.detect('não mande nada')
      expect(result.matched).toBe(true)
      if (result.matched) {
        expect(result.pattern).toBe('não quero')
      }
    })
  })

  describe('does NOT flag normal messages', () => {
    it('does NOT flag "ok obrigado"', () => {
      const result = detector.detect('ok obrigado')
      expect(result.matched).toBe(false)
    })

    it('does NOT flag "parede" (contains "pare" but is a different word)', () => {
      const result = detector.detect('a parede está bonita')
      expect(result.matched).toBe(false)
    })

    it('does NOT flag "reparei" (contains "pare" but is a different word)', () => {
      const result = detector.detect('eu reparei nisso')
      expect(result.matched).toBe(false)
    })

    it('does NOT flag "aparelho"', () => {
      const result = detector.detect('meu aparelho é bom')
      expect(result.matched).toBe(false)
    })

    it('does NOT flag normal business reply', () => {
      const result = detector.detect('vou pagar amanhã, obrigado pelo aviso')
      expect(result.matched).toBe(false)
    })

    it('does NOT flag "compararei"', () => {
      const result = detector.detect('compararei os preços')
      expect(result.matched).toBe(false)
    })
  })

  describe('returns matched pattern', () => {
    it('returns the matched pattern label', () => {
      const result = detector.detect('PARE de enviar')
      expect(result.matched).toBe(true)
      if (result.matched) {
        expect(result.pattern).toBe('pare')
        expect(result.original).toBe('PARE de enviar')
      }
    })
  })

  describe('edge cases', () => {
    it('handles empty string', () => {
      const result = detector.detect('')
      expect(result.matched).toBe(false)
    })

    it('handles whitespace-only string', () => {
      const result = detector.detect('   ')
      expect(result.matched).toBe(false)
    })

    it('handles null', () => {
      const result = detector.detect(null)
      expect(result.matched).toBe(false)
    })

    it('handles undefined', () => {
      const result = detector.detect(undefined)
      expect(result.matched).toBe(false)
    })
  })
})
