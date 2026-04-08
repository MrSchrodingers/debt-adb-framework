import { describe, it, expect } from 'vitest'
import { escapeForAdbContent } from './contact-utils.js'

describe('escapeForAdbContent', () => {
  it('wraps simple name in single quotes', () => {
    expect(escapeForAdbContent('Matheus')).toBe("'Matheus'")
  })

  it('preserves spaces inside single quotes', () => {
    expect(escapeForAdbContent('Matheus Amaral Parra Munhoz')).toBe("'Matheus Amaral Parra Munhoz'")
  })

  it('handles accented characters (João)', () => {
    expect(escapeForAdbContent('João da Silva')).toBe("'João da Silva'")
  })

  it('escapes single quotes in names (O\'Brien)', () => {
    const result = escapeForAdbContent("O'Brien")
    expect(result).toBe("'O'\"'\"'Brien'")
    // This shell-evaluates to: O'Brien
  })

  it('handles empty string', () => {
    expect(escapeForAdbContent('')).toBe("''")
  })

  it('handles phone number with plus', () => {
    expect(escapeForAdbContent('+5543991938235')).toBe("'+5543991938235'")
  })

  it('handles multiple special chars', () => {
    const result = escapeForAdbContent("Maria d'Ávila O'Connor")
    // Each ' becomes '"'"'
    expect(result).toContain("'\"'\"'")
    // Should start and end with single quotes
    expect(result.startsWith("'")).toBe(true)
    expect(result.endsWith("'")).toBe(true)
  })
})
