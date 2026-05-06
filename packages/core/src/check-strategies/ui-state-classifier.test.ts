import { describe, it, expect } from 'vitest'
import { classifyUiState } from './ui-state-classifier.js'

describe('classifyUiState — smoke', () => {
  it('returns unknown for empty XML', () => {
    const r = classifyUiState({ xml: '' })
    expect(r.state).toBe('unknown')
    expect(r.decisive).toBe(false)
    expect(r.retryable).toBe(true)
  })
})
