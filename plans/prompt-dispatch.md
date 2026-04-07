# Prompt — Dispatch ADB Framework (Plugin Oralsin)

Cole este prompt inteiro ao iniciar uma nova sessão Claude Code no diretório `/var/www/adb_tools`:

---

Sou o Matheus, Principal Software Architect. Tudo em português.

## Contexto

Estou trabalhando no **Dispatch ADB Framework** — um sistema que envia mensagens WhatsApp via automação ADB em dispositivos Android físicos. O sistema já tem 8 fases implementadas e aprovadas (354 testes passando).

Agora preciso implementar a **integração com o sistema Oralsin** (sistema de cobrança automatizada de clínicas odontológicas). A Oralsin envia notificações WhatsApp para pacientes inadimplentes e o Dispatch será o provedor de envio primário (ADB), com fallback para WAHA (WhatsApp Web API).

## Arquivos para ler (nesta ordem)

1. `plans/dispatch-oralsin-plugin.md` — **PLANO DE IMPLEMENTAÇÃO** com 6 fases, dependências, acceptance criteria
2. `docs/research/integration-contracts.md` — **CONTRATOS DE API** (JSON schemas, HMAC, error codes)
3. `docs/research/integration-dependency-graph.md` — **GRAFO DE DEPENDÊNCIAS** entre fases
4. `docs/research/oralsin-dispatch-full-spec.md` — **SPEC COMPLETA** (referência detalhada)
5. `CLAUDE.md` — **CONVENÇÕES** do projeto (TDD, naming, git, testing)

## Estado atual

- 354 testes passando (32 arquivos)
- Todas 8 fases APPROVED
- Plugin Oralsin básico já existe (`packages/core/src/plugins/oralsin-plugin.ts`)
- WAHA integration já existe (`packages/core/src/waha/`)
- Callback system já existe (`packages/core/src/plugins/callback-delivery.ts`)
- 2 devices POCO C71 com root, 8 users cada, 16 números WhatsApp por device

## O que fazer

Execute o plano `plans/dispatch-oralsin-plugin.md` fase por fase:

1. **DP-1**: Sender Mapping + Grouped Enqueue
2. **DP-2**: Receipt Tracking
3. **DP-3**: WAHA Fallback
4. **DP-4**: Callback Enhancement
5. **DP-5**: Queue Optimization
6. **DP-6**: Headless Mode

Siga o protocolo TDD do CLAUDE.md: grill → testes falhando → implementar → testes passando → review.

## Regras

- O **core deve ser agnóstico** — toda lógica Oralsin fica no PLUGIN
- O core fornece: queue, send engine, WAHA client, callback delivery
- O plugin fornece: sender mapping, batch enqueue, Oralsin-specific routes
- Contratos de API estão em `docs/research/integration-contracts.md`
- Idempotência obrigatória em toda operação de escrita
- Audit trail completo (correlationId em todos os logs)
