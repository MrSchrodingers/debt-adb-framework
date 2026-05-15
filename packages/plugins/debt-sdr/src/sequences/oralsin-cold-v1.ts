import { registerSequence } from './sequence-definition.js'

/**
 * Oralsin cold-outbound v1 — day 0/2/5 three-touch sequence.
 *
 * Templates are PLACEHOLDERS — operator MUST review and rewrite before
 * sending in volume. Each pool intentionally has 2-3 variations so the
 * deterministic selector spreads load without identical wording across
 * leads.
 */
registerSequence({
  id: 'oralsin-cold-v1',
  version: 1,
  description: 'Oralsin SDR cold-outbound, 3 toques (dia 0/2/5)',
  steps: [
    {
      index: 0,
      day_offset: 0,
      label: 'cold-1: apresentação',
      terminal: false,
      template_pool: [
        'Oi {nome}, tudo bem? Aqui é a {empresa}. Vi que você tem um caso parado e quero te apresentar uma proposta rápida.',
        '{nome}, beleza? Sou da {empresa} — tenho uma forma de resolver seu caso sem complicação, posso te explicar?',
        'Olá {nome}! Da {empresa} aqui. Tem 2 minutos pra eu te mostrar uma alternativa pro seu caso?',
      ],
    },
    {
      index: 1,
      day_offset: 2,
      label: 'cold-2: prova social',
      terminal: false,
      template_pool: [
        '{nome}, voltei rapidinho. Várias pessoas em situação parecida já resolveram com a gente. Quer ver como?',
        'Oi {nome}, mandei mensagem outro dia. Vejo que você não respondeu — tem como falar agora?',
        '{nome}, posso te mostrar um caso real? Resolvemos algo parecido com o seu na semana passada.',
      ],
    },
    {
      index: 2,
      day_offset: 5,
      label: 'cold-3: encerramento',
      terminal: true,
      template_pool: [
        '{nome}, última tentativa por aqui — se ainda fizer sentido conversar, me chama. Caso contrário, te dou um respiro.',
        'Oi {nome}, se você não tiver mais interesse tudo bem — só me avisa e eu paro de mandar. Caso queira, ainda tô por aqui.',
        '{nome}, vou parar de te incomodar por aqui. Mas se mudar de ideia, é só responder essa mensagem que retomo.',
      ],
    },
  ],
})
