# Prompt — Oralsin (Adapter Dispatch ADB)

Cole este prompt inteiro ao iniciar uma nova sessão Claude Code no diretório `/var/www/oralsim_gestao_inteligente`:

---

Sou o Matheus, Principal Software Architect. Tudo em português.

## Contexto

Estou trabalhando no **sistema de notificação da Oralsin** (cobrança automatizada de clínicas odontológicas). Atualmente as notificações WhatsApp são enviadas via **WAHA Plus** (WhatsApp Web API). Estou adicionando um novo provedor de envio: **Dispatch ADB Framework** — que envia mensagens via automação ADB em dispositivos Android físicos, simulando digitação humana para reduzir banimentos.

O Dispatch será o provedor **primário** (ADB naturalizado) com **fallback para WAHA** (quando ADB falhar).

## Arquivos para ler (nesta ordem)

1. `docs/dispatch/oralsin-dispatch-adapter.md` — **PLANO DE IMPLEMENTAÇÃO** com 6 fases, código Python completo, migrations
2. `docs/dispatch/integration-contracts.md` — **CONTRATOS DE API** (JSON schemas, HMAC, error codes)
3. `docs/dispatch/integration-dependency-graph.md` — **GRAFO DE DEPENDÊNCIAS** entre fases
4. `docs/dispatch/oralsin-dispatch-full-spec.md` — **SPEC COMPLETA** (referência detalhada com modelos, webhooks, pipeline)

Para entender o código existente, leia:
5. `src/notification_billing/adapters/providers/waha/client.py` — provedor WAHA atual (padrão a seguir)
6. `src/notification_billing/core/application/services/notification_handlers.py` — orquestrador de notificações
7. `src/notification_billing/core/application/services/phone_pool_service.py` — pool de números e adoption rule
8. `src/notification_billing/core/domain/models/` — modelos Django

## Estado atual

- Django + Temporal + RabbitMQ + PostgreSQL + Redis
- 4 clínicas ativas (Divinópolis, Balneário Camboriú, Volta Redonda, Bauru)
- 8 phone pairs no WAHA (GoWS server)
- 14-step escalation flow (WhatsApp em 11 de 14 steps)
- ~16 msgs/dia atual (early production), 285 pendentes
- Projeção: 800+ msgs/dia
- **ESTE É SERVIDOR DE PRODUÇÃO** — NÃO quebrar nada existente

## O que fazer

Execute o plano `docs/dispatch/oralsin-dispatch-adapter.md` fase por fase:

1. **OP-1**: DispatchNotifier Adapter (novo provider em `adapters/providers/dispatch/`)
2. **OP-2**: Sender-Grouped Batching
3. **OP-3**: Callback Webhook (receber feedback do Dispatch)
4. **OP-4**: Configuration (feature flags per clinic, env vars)
5. **OP-5**: Fallback Logic (Dispatch primary → WAHA fallback)
6. **OP-6**: Monitoring (alertas Telegram)

## Regras

- **NÃO quebrar o fluxo WAHA existente** — tudo deve ser aditivo
- Feature flags per clinic: `DISPATCH_CLINIC_IDS=47,423` (Bauru e Volta Redonda primeiro)
- Seguir os patterns existentes (BaseNotifier, PhonePoolService, etc.)
- Write-ahead pattern: criar ContactHistory com outcome="pending" ANTES de enviar
- Idempotência: `schedule_id + channel` como chave única
- Contratos de API: `docs/dispatch/integration-contracts.md`
- Pilot: começar com Bauru (22 pendentes, menor volume)
- Todo callback do Dispatch é validado com HMAC SHA-256
- Testes com pytest, fixtures Django, mock para HTTP calls ao Dispatch
