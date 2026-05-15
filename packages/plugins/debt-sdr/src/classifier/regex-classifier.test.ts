import { describe, it, expect } from 'vitest'
import { regexClassify } from './regex-classifier.js'

function expectCategory(text: string, expected: string) {
  const r = regexClassify(text)
  expect(r, `text="${text}"`).not.toBeNull()
  expect(r!.category).toBe(expected)
  expect(r!.confidence).toBe(1.0)
}

describe('regexClassify — opt-out (priority 0)', () => {
  for (const text of [
    'Para de mandar mensagem',
    'Pare de me mandar isso',
    'Pode cancelar tudo',
    'Cancela esse serviço',
    'Não me envie mais nada',
    'Não me mande mais',
    'descadastra meu numero',
    'remover da lista por favor',
    'STOP',
    'unsubscribe',
    'bloqueei voces',
  ]) {
    it(`classifies "${text}" as opted_out`, () => expectCategory(text, 'opted_out'))
  }
})

describe('regexClassify — identity_deny', () => {
  for (const text of [
    'Não sou eu',
    'não sou essa pessoa',
    'numero errado',
    'telefone errado',
    'celular errado',
    'Não conheço',
    'foi engano',
    'Voce ta enganado',
    'nunca ouvi falar',
  ]) {
    it(`classifies "${text}" as identity_deny`, () => expectCategory(text, 'identity_deny'))
  }
})

describe('regexClassify — identity_confirm', () => {
  for (const text of [
    'Sim',
    'sou eu',
    'Sim, sou eu',
    'Sou o João',
    'Oi',
    'Olá',
    'Bom dia',
    'Boa tarde',
    'é eu mesmo',
  ]) {
    it(`classifies "${text}" as identity_confirm`, () => expectCategory(text, 'identity_confirm'))
  }
})

describe('regexClassify — not_interested', () => {
  for (const text of [
    'Não tenho interesse',
    'Não estou interessado',
    'agora não quero',
    'não obrigado',
    'dispenso',
    'já resolvi',
    'já tenho',
    'sem interesse',
  ]) {
    it(`classifies "${text}" as not_interested`, () => expectCategory(text, 'not_interested'))
  }
})

describe('regexClassify — interested', () => {
  for (const text of [
    'tenho interesse sim',
    'estou interessado',
    'me conta mais',
    'fala mais',
    'quero saber',
    'qual a proposta',
    'aceito',
    'pode mandar',
  ]) {
    it(`classifies "${text}" as interested`, () => expectCategory(text, 'interested'))
  }
})

describe('regexClassify — question', () => {
  for (const text of [
    'como funciona?',
    'O que é isso?',
    'não entendi',
    'pode explicar',
  ]) {
    it(`classifies "${text}" as question`, () => expectCategory(text, 'question'))
  }
})

describe('regexClassify — priority resolution', () => {
  it('"não sou eu, para de mandar" → opted_out (opt-out beats identity_deny)', () => {
    expectCategory('não sou eu, para de mandar', 'opted_out')
  })

  it('"oi, mas não sou eu" → identity_deny (deny beats confirm)', () => {
    expectCategory('oi, mas não sou eu', 'identity_deny')
  })
})

describe('regexClassify — non-matches return null', () => {
  for (const text of [
    'xyz',
    '',
    '   ',
    'hmm',
    '🤔',
  ]) {
    it(`returns null for "${text}"`, () => expect(regexClassify(text)).toBeNull())
  }
})

describe('regexClassify — return shape', () => {
  it('includes matched_pattern as a regex source string', () => {
    const r = regexClassify('Sim')
    expect(r).not.toBeNull()
    expect(typeof r!.matched_pattern).toBe('string')
    expect(r!.matched_pattern.length).toBeGreaterThan(0)
  })
})
