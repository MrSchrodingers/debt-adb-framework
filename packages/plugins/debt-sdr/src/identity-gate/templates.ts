/**
 * Identity-gate handshake template pools (pt-BR informal).
 *
 * Two pools: INTRO (first handshake, day 0) and NUDGE (after no reply,
 * default 48h later). Selection is deterministic per contact phone (see
 * template-selector.ts) so the same lead always sees the same variation
 * — important because mid-thread template swaps look suspicious to the
 * recipient and confuse the operator audit.
 *
 * Placeholders: `{nome}` for the contact name, `{empresa}` for the tenant
 * label (Oralsin / Sicoob). Template renderer leaves unknown
 * placeholders intact so a missing variable surfaces as `{xxx}` in the
 * outbound text rather than the dreaded `undefined`.
 */

export const INTRO_TEMPLATES: readonly string[] = [
  'Oi {nome}, tudo bem? Aqui é da {empresa}, tô tentando falar contigo. Pode confirmar se é o número certo?',
  'Olá {nome}! Aqui é da {empresa}. Tô precisando trocar uma ideia rápida — posso?',
  'Oi {nome}, esse número é seu? Sou da {empresa}, tenho uma proposta pra te apresentar.',
  'Boa tarde {nome}, da {empresa} aqui. Confirma pra mim se falo com você?',
  'Oi {nome}, aqui é da {empresa} — esse contato é o seu mesmo?',
  '{nome}, tudo joia? Aqui é da {empresa}. Pode falar agora?',
  'Olá {nome}! Sou da {empresa} e queria entender se faz sentido continuar essa conversa contigo.',
  'Oi {nome}, é da {empresa}. Esse é seu número? Tenho algo rápido pra te mostrar.',
  'Bom dia {nome}, aqui da {empresa}. Você é a pessoa certa pra falar disso?',
  'Oi {nome}! Sou da {empresa}. Pode confirmar seu nome pra eu não falar com a pessoa errada?',
  'Oi {nome}, tudo bem? {empresa} aqui — preciso confirmar uma info rápida com você.',
  'Olá {nome}, da {empresa}. Esse número é o seu? Posso seguir com a proposta?',
  'Oi {nome}, te procurei aqui pela {empresa}. Tem 2 minutos pra falar?',
  'Oi, {nome}? Da {empresa} aqui — quero te apresentar uma oportunidade.',
  '{nome}, tudo bem? Sou da {empresa}, tô tentando confirmar se esse é seu WhatsApp.',
  'Oi {nome}! Da {empresa} aqui. Pode falar?',
  'Olá {nome}, {empresa} falando. Esse número é seu mesmo?',
  'Oi {nome}, sou da {empresa}. Posso te mandar uma proposta?',
  'Oi {nome}, aqui é da {empresa}. Você tá disponível pra trocar uma ideia?',
  'Bom dia {nome}! Sou da {empresa} — confirma pra mim se falo com você certo?',
  'Olá {nome}, é da {empresa}. Esse número é o seu? Tenho um assunto rápido.',
  '{nome}, tudo certo? Sou da {empresa}, tô tentando te apresentar uma proposta.',
  'Oi {nome}! Aqui é da {empresa}. Pode confirmar seu nome?',
  'Oi {nome}, da {empresa} — você é a pessoa certa pra essa conversa?',
  '{nome}? Sou da {empresa}, confirma pra mim que esse número é seu?',
] as const

export const NUDGE_TEMPLATES: readonly string[] = [
  'Oi {nome}, ainda tá por aí? Da {empresa} aqui, só pra confirmar se posso seguir.',
  '{nome}, dei uma puxada pra ver se você viu. Posso continuar?',
  'Oi {nome}, segue minha mensagem anterior — pode falar agora?',
  '{nome}, ainda dá pra trocar uma ideia? Sou da {empresa}.',
  'Oi {nome}, viu minha mensagem? Posso te mandar a proposta?',
  '{nome}, sei que tá corrido, mas você conseguiu olhar minha mensagem?',
  'Oi {nome}, voltei aqui rapidinho. Da {empresa} — esse é seu número mesmo?',
  '{nome}, só pra não perder o contato — você é a pessoa certa pra falar disso?',
  'Oi {nome}, ainda tá ativo nesse número? Sou da {empresa}.',
  '{nome}, posso continuar a conversa? Da {empresa} aqui.',
  'Oi {nome}, voltei rapidinho — esse número é seu mesmo?',
  '{nome}, mandei mensagem outro dia. Da {empresa} aqui — tem como continuar?',
] as const
