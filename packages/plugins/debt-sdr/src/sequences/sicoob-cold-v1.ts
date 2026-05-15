import { registerSequence } from './sequence-definition.js'

/**
 * Sicoob cold-outbound v1 — day 0/2/5 three-touch sequence.
 *
 * PLACEHOLDER templates — operator MUST review before sending in
 * volume. Tone is slightly more institutional than Oralsin's
 * (financial cooperative vs. dental clinic).
 */
registerSequence({
  id: 'sicoob-cold-v1',
  version: 1,
  description: 'Sicoob SDR cold-outbound, 3 toques (dia 0/2/5)',
  steps: [
    {
      index: 0,
      day_offset: 0,
      label: 'cold-1: apresentação',
      terminal: false,
      template_pool: [
        'Olá {nome}, tudo bem? Aqui é da {empresa}. Identifiquei seu nome em uma lista e tenho uma proposta financeira pra te apresentar.',
        '{nome}, bom dia. Sou da {empresa}. Posso te explicar rapidamente uma condição que pode ajudar você nesse momento?',
        'Oi {nome}, da {empresa} aqui. Tenho uma proposta de crédito pra te apresentar — você tem alguns minutos?',
      ],
    },
    {
      index: 1,
      day_offset: 2,
      label: 'cold-2: reforço',
      terminal: false,
      template_pool: [
        '{nome}, voltando aqui — você conseguiu olhar minha mensagem da {empresa}?',
        'Oi {nome}, sei que sua agenda é apertada. Pode falar agora sobre a proposta da {empresa}?',
        '{nome}, mandei contato pela {empresa} dois dias atrás. Posso te enviar mais detalhes?',
      ],
    },
    {
      index: 2,
      day_offset: 5,
      label: 'cold-3: encerramento',
      terminal: true,
      template_pool: [
        '{nome}, última mensagem por aqui. Se não fizer sentido agora, sem problema. Caso queira retomar, é só responder.',
        'Oi {nome}, vou encerrar nosso contato por aqui. Se mudar de ideia, da {empresa} tô à disposição.',
        '{nome}, sem pressão. Estou encerrando esse contato — quando fizer sentido, é só me chamar.',
      ],
    },
  ],
})
