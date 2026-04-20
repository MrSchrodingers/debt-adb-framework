# Execution Prompt — Dispatch Hardening

> **Copy this prompt to start a new Claude Code session with ZERO context.**

---

## Prompt

Sou o Matheus, Principal Software Architect. Tudo em português.

## Contexto

Estou trabalhando no **Dispatch ADB Framework** (`/var/www/adb_tools`) — um sistema que envia mensagens WhatsApp via automação ADB em dispositivos Android físicos. O sistema tem integração com o **Oralsin** (sistema de cobrança de clínicas odontológicas).

## Estado Atual

- **444 testes** passando (40 arquivos)
- **Integração bilateral Oralsin↔Dispatch** validada (HMAC, callbacks, enqueue)
- **6 bugs críticos** encontrados no E2E testing que BLOQUEIAM uso em produção
- **Dispatch server PARADO** — não fazer mais testes com Oralsin até os bugs serem corrigidos

## O que fazer

Execute o plano `docs/superpowers/plans/2026-04-07-dispatch-hardening.md` usando **subagent-driven-development**.

**Leia estes arquivos na ordem:**
1. `docs/superpowers/plans/dispatch-hardening-context.md` — contexto zero do projeto, arquivos, DB, commands
2. `docs/superpowers/plans/2026-04-07-dispatch-hardening.md` — plano com 7 tasks e dependency graph
3. `CLAUDE.md` — convenções do projeto

## Dependency Graph

```
Phase A (parallel): T1 (Worker Loop) + T2 (Dialog Detection) + T3 (Contact Escaping)
Phase B (after A):  T4 (Screenshot Audit) + T5 (Callback Retry)
Phase C (after A):  T6 (Pre-Send Health)
Phase D (GATE):     T7 (E2E Local Validation)
```

## Regras ABSOLUTAS

1. **NUNCA declarar algo pronto sem testar no device físico** — tem um POCO C71 conectado via ADB
2. **Cada task termina com `npx turbo test --filter=@dispatch/core` passando**
3. **Code review (spec + quality) obrigatório após cada task**
4. **Task 7 é GATE — sem ela passando, NÃO re-engajar Oralsin**
5. **Salvar screenshots como prova de cada teste no device**
6. **Commit após cada task com mensagem descritiva**

## Device de teste

```
SERIAL=9b01005930533036340030832250ac
TEST_PHONE=5543991938235
```

4 WhatsApp accounts registrados:
- User 0: +5543996835100 (oralsin_2_main)
- User 10: +5543996835095 (oralsin_2_1)
- User 11: +5543996837813 (oralsin_2_2)
- User 12: +5543996837844 (oralsin_2_3)
