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
