# DEBT ADB Framework — Development Protocol

## Project Identity

**Product**: DEBT ADB Framework (codename Dispatch)
**Repo**: https://github.com/MrSchrodingers/debt-adb-framework
**PRD**: `docs/PRD-dispatch.md`
**Plan**: `plans/dispatch-implementation.md`
**Stack**: Turborepo monorepo — Node.js 22, TypeScript, Fastify, React 19, Electron, SQLite, adbkit
**Architecture**: Headless-first, plugin-based. Core runs standalone or embedded in Electron.

## Test Phone

**ALL integration tests and E2E sends must target this number:**
```
TEST_PHONE_NUMBER=5543991938235
```
This is the developer's personal number for real-device monitoring. Never send to any other number during development.

## Context Recovery Protocol

> **CRITICAL**: This project uses file-based state that survives context rotation.
> On EVERY new session or after context compilation, ALWAYS run:

```
1. Read `.dev-state/progress.md` — current phase, blockers, pending reviews
2. Read `plans/dispatch-implementation.md` — full implementation plan
3. Read the phase-specific file `.dev-state/phase-{N}-review.md` if it exists
4. Resume from where progress.md says we are
```

**Never assume you know the current state. Always read the files first.**

## Development Workflow — Mandatory Pipeline

Every piece of work follows this pipeline. No exceptions. No shortcuts.

```
┌──────────────────────────────────────────────────────────────────────┐
│                    PHASE EXECUTION PIPELINE                          │
│                                                                      │
│  ┌─────────┐    ┌─────────┐    ┌──────────┐    ┌────────────────┐  │
│  │ GRILL   │───►│  TDD    │───►│ IMPLEMENT│───►│ CODE REVIEW    │  │
│  │         │    │         │    │          │    │                │  │
│  │ Stress  │    │ Red →   │    │ Green →  │    │ Architecture + │  │
│  │ test    │    │ Write   │    │ Make     │    │ Security +     │  │
│  │ design  │    │ failing │    │ tests    │    │ Conventions    │  │
│  │ before  │    │ tests   │    │ pass     │    │                │  │
│  │ coding  │    │ first   │    │          │    │                │  │
│  └─────────┘    └─────────┘    └──────────┘    └───────┬────────┘  │
│                                                         │           │
│                    ┌──────────────┐    ┌─────────────────▼────────┐ │
│                    │ PHASE GATE   │◄───│ E2E VALIDATION           │ │
│                    │              │    │                          │ │
│                    │ All criteria │    │ Run full test suite +    │ │
│                    │ met? Review  │    │ send test msg to         │ │
│                    │ artifacts    │    │ 5543991938235            │ │
│                    │ approved?    │    │                          │ │
│                    │              │    │ Screenshot proof         │ │
│                    │ YES → next   │    │ saved to reports/        │ │
│                    │ NO → fix     │    │                          │ │
│                    └──────────────┘    └──────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

## Phase Dependency Graph & Execution Plan

```
Phase 1 (Tracer Bullet)
  ├──► Phase 2 (Multi-Device)
  │      ├──► Phase 3 (Send Engine) ─────────┐
  │      │                                     ├──► Phase 7 (Plugins + Oralsin)
  │      └──► Phase 6 (Dashboard) ◄── Phase 4 │
  │                    │                       │
  └──► Phase 4 (WAHA) ├──► Phase 5 (Chatwoot) ┘
                       │
                       └──► Phase 8 (Hardening) ◄── Phase 3 + Phase 6

Critical Path:  1 → 2 → 3 → 7
Parallel Track: 1 → 4 → 5 (merges at 7)
Dashboard:      2 + 4 → 6
Hardening:      3 + 6 → 8
```

### Execution Bullets — Fase 1: Tracer Bullet
> **Deps**: nenhuma | **Issue**: #1 | **Estimativa**: G

- [x] **Scaffold** Turborepo: `packages/core`, `packages/ui`, `packages/electron`
- [x] **Grill** design da fila + locking SQLite (`/grill-me`)
- [x] **TDD Red** — testes de idempotency, lock exclusivity, dequeue atomico (`/tdd`)
- [x] **Implement** ADB Bridge: `adbkit` wrapper, `discover()`, `health()`, `shell()`
- [x] **Implement** Message Queue: SQLite WAL, `BEGIN IMMEDIATE` + CAS, stale lock cleanup
- [x] **Implement** Send Engine (minimal): `wa.me` intent → typing char-by-char → screenshot
- [x] **Implement** REST API: `POST /messages` (201/409), `GET /devices`
- [x] **Implement** Socket.IO: events `message:queued`, `message:sending`, `message:sent`
- [x] **Implement** UI minimal: 1 device card + fila + status
- [x] **Implement** Electron shell: main process carrega core + BrowserWindow carrega UI
- [x] **TDD Green** — todos os testes passando
- [x] **E2E** — enviar msg real para `5543991938235` via ADB no POCO Serenity
- [x] **Simplify** — `/simplify` review do codigo escrito
- [x] **Code Review** — `superpowers:requesting-code-review`
- [x] **Verify** — `superpowers:verification-before-completion`
- [x] **Phase Gate** — atualizar `.dev-state/progress.md` → APPROVED ou FAILED_REVIEW

### Execution Bullets — Fase 2: Multi-Device + Health
> **Deps**: Fase 1 APPROVED | **Issue**: #2 | **Estimativa**: M

- [x] **Grill** device discovery, health polling, alert thresholds (`/grill-me`)
- [x] **TDD Red** — testes de discovery mock, alert thresholds, health persistence
- [x] **Implement** Device Manager: auto-discovery via `adb devices` polling (5s)
- [x] **Implement** Health Collector: RAM, bateria, temp, storage, WiFi (30s poll)
- [x] **Implement** WA Account Mapper: device → profile → WA/WAB → numero
- [x] **Implement** Alert System: thresholds configuraveis + EventEmitter + SQLite
- [x] **Implement** UI: device grid, health cards, spark charts, alert panel
- [x] **Implement** Actions: screenshot sob demanda, reboot, restart WhatsApp
- [x] **TDD Green** + **E2E** conectar 2+ devices, verificar health
- [x] **Review** + **Verify** + **Phase Gate**

### Execution Bullets — Fase 3: Send Engine Robusto + Anti-Ban
> **Deps**: Fase 2 APPROVED | **Issue**: #3 | **Estimativa**: G

- [x] **Grill** rate limiting, distribution algorithm, ban detection (`/grill-me`)
- [x] **TDD Red** — testes: rate limiter timing, distribution fairness, ban detection (fixtures), retry
- [x] **Implement** Rate Limiter: port exato do WAHA client Oralsin (volume scaling exponencial)
- [x] **Implement** Distribuicao: round-robin ponderado (health score × inverse send count)
- [x] **Implement** Ban Detection: screenshot + Tesseract.js OCR (crop centro, strings, confidence >= 60%)
- [x] **Implement** Retry: mensagem volta para fila, re-roteada, `attempts++`
- [x] **Implement** Auto-recovery: WA crash → force-stop + intent restart + retry
- [x] **Implement** Contact Registration: intent ACTION_INSERT, fallback wa.me
- [x] **Implement** Jitter: distribuicao exponencial 30s-5min entre msgs
- [x] **TDD Green** + **E2E** enviar batch de 5 msgs para `5543991938235` com rate limit
- [x] **Review** + **Verify** + **Phase Gate**

### Execution Bullets — Fase 4: WAHA Listener Passivo
> **Deps**: Fase 1 APPROVED | **Issue**: #4 | **Estimativa**: M
> **PARALELO** com Fases 2/3

- [x] **Grill** WAHA session lifecycle, multi-device sync, independence (`/grill-me`)
- [x] **TDD Red** — testes: webhook processing, session health, independence
- [x] **Implement** Session Manager: parear WAHA por numero, exponential backoff (5s→80s, 5x)
- [x] **Implement** Webhook Receiver: `POST /api/v1/webhooks/waha` (message.received, message.sent)
- [x] **Implement** Message History: persistir in+out em `message_history`
- [ ] **Implement** Health Check: verificar sessoes, re-parear se caiu
- [ ] **Implement** Independence: ban WAHA gera alerta, NAO pausa ADB
- [ ] **TDD Green** + **E2E** capturar msg outgoing enviada via ADB
- [ ] **Review** + **Verify** + **Phase Gate**

### Execution Bullets — Fase 5: Chatwoot Bridge Bidirecional
> **Deps**: Fase 4 APPROVED | **Issue**: #5 | **Estimativa**: M

- [ ] **Grill** routing de operator reply, device offline, TTL (`/grill-me`)
- [ ] **TDD Red** — testes: Chatwoot API mock, webhook processing, bidirectional flow
- [ ] **Implement** Inbox Manager: criar inbox Chatwoot por numero
- [ ] **Implement** Contact Sync: criar/atualizar contato Chatwoot
- [ ] **Implement** Incoming Bridge: WAHA webhook → Chatwoot message
- [ ] **Implement** Outgoing Bridge: ADB send confirmado → Chatwoot outgoing
- [ ] **Implement** Operator Reply: Chatwoot webhook → fila Dispatch → ADB
- [ ] **Implement** Offline handling: re-route, `waiting_device`, TTL 4h
- [ ] **TDD Green** + **E2E** conversa bidirecional visivel no Chatwoot
- [ ] **Review** + **Verify** + **Phase Gate**

### Execution Bullets — Fase 6: Dashboard Operacional
> **Deps**: Fase 2 + Fase 4 APPROVED | **Issue**: #6 | **Estimativa**: M

- [ ] **Grill** Socket.IO rooms strategy, pagination, real-time update frequency
- [ ] **TDD Red** — component tests (RTL), Socket.IO event handling
- [ ] **Implement** Device Grid: cards com RAM, bateria, temp, storage, WA accounts
- [ ] **Implement** Queue Panel: pendentes/enviando/enviadas/falhadas + filtros
- [ ] **Implement** Audit Log: historico completo in+out, busca por numero/data/status
- [ ] **Implement** Alert Panel: ativos/resolvidos, severity, acao "resolver"
- [ ] **Implement** Metrics: taxa sucesso, latencia, volume hora/dia (Recharts)
- [ ] **Implement** Responsivo: Electron + browser
- [ ] **TDD Green** + **E2E** dashboard reflete envio real em < 2s
- [ ] **Review** + **Verify** + **Phase Gate**

### Execution Bullets — Fase 7: Plugin System + Plugin Oralsin
> **Deps**: Fase 3 + Fase 5 APPROVED | **Issue**: #7 | **Estimativa**: G
> **PRIMEIRO TESTE REAL COM PRODUCAO**

- [ ] **Grill** plugin lifecycle, event bus isolation, callback guarantee (`/grill-me`)
- [ ] **TDD Red** — testes: plugin lifecycle, Oralsin adapter, fallback chain, event bus
- [ ] **Implement** Plugin Interface: `{ name, version, init(core), destroy() }`
- [ ] **Implement** Plugin Registry: load/unload/configure via SQLite + REST
- [ ] **Implement** Event Bus: typed events, async handlers, try/catch isolado, 5s timeout
- [ ] **Implement** Route Injection: plugins registram rotas no Fastify
- [ ] **Implement** `DispatchNotifier(BaseNotifier)` na Oralsin
- [ ] **Implement** Callback webhook: at-least-once, 3 retries, `failed_callbacks` table
- [ ] **Implement** Fallback chain: ADB → WAHA API → SMS
- [ ] **Implement** FlowStepConfig channel="adb" no registry Oralsin
- [ ] **TDD Green** + **E2E** Oralsin enfileira notificacao → ADB envia para `5543991938235`
- [ ] **INTEGRATION TEST** fluxo completo: Oralsin schedule → Dispatch → ADB → WAHA capture → Chatwoot
- [ ] **Review** + **Verify** + **Phase Gate**

### Execution Bullets — Fase 8: Multi-Profile + Hardening + Docker
> **Deps**: Fase 3 + Fase 6 APPROVED | **Issue**: #8 | **Estimativa**: G

- [ ] **Grill** multi-profile locking, graceful shutdown, Docker USB passthrough
- [ ] **TDD Red** — testes: multi-profile lock, graceful shutdown, headless mode
- [ ] **Implement** Multi-profile: `am start --user N`, routing por profile, lock por device
- [ ] **Implement** Headless validation: core standalone em Linux server
- [ ] **Implement** Docker: Dockerfile, USB passthrough `--privileged`, ADB tools
- [ ] **Implement** Graceful shutdown: drain queue, finish sends, persist state
- [ ] **Implement** Config: `.env` + `dispatch.config.json` hot-reload
- [ ] **Implement** Log rotation: pino-roll (50MB, 5 backups)
- [ ] **Implement** Encryption: credenciais SQLite encriptadas (PBKDF2 de machine-id)
- [ ] **TDD Green** + **E2E** 4 profiles enviando, headless mode, Docker build
- [ ] **Review** + **Verify** + **Phase Gate**

### Sprint Allocation (Sugestao)

```
Semana 1-2:  Fase 1 (Tracer Bullet)
Semana 2-3:  Fase 2 (Multi-Device) + Fase 4 (WAHA) em paralelo
Semana 3-4:  Fase 3 (Send Engine) + Fase 5 (Chatwoot) em paralelo
Semana 4-5:  Fase 6 (Dashboard) — aproveita Fase 2+4 prontas
Semana 5-7:  Fase 7 (Plugins + Oralsin) — PRIMEIRO TESTE REAL
Semana 7-8:  Fase 8 (Hardening + Docker)
```

## Slash Commands — Development Operations

### `/phase-start <N>`

Start working on Phase N. Mandatory checklist:

1. **Read** `.dev-state/progress.md` — verify all dependencies are APPROVED
2. **Read** `plans/dispatch-implementation.md` Phase N section
3. **Read** the GitHub issue (MrSchrodingers/debt-adb-framework#N)
4. **Verify** dependency phases are APPROVED in progress.md
5. **Grill** the design: stress-test edge cases, concurrency, failure modes
6. **Write** failing tests FIRST (TDD red phase)
7. **Update** `.dev-state/progress.md` status to `IN_PROGRESS`
8. **Create** `.dev-state/phase-{N}-review.md` with initial checklist

If a dependency phase is not APPROVED, STOP and inform the developer.

### `/phase-review <N>`

Trigger end-of-phase review. Mandatory steps:

1. **Run** full test suite: `npm test`
2. **Run** E2E validation if applicable (send to TEST_PHONE_NUMBER)
3. **Review** all code written in this phase against:
   - PRD criteria (docs/PRD-dispatch.md)
   - Plan criteria (plans/dispatch-implementation.md Phase N)
   - Clean architecture principles
   - Security (no hardcoded credentials, injection risks)
   - Idempotency of all write operations
   - Error handling and resilience
4. **Generate** review report in `.dev-state/phase-{N}-review.md`:
   - Files changed (with line counts)
   - Tests written (with pass/fail)
   - Criteria checklist (from plan)
   - Issues found (blocking / non-blocking)
   - Screenshots/proof of E2E if applicable
5. **Update** `.dev-state/progress.md`

### `/phase-approve <N>`

Mark Phase N as APPROVED after review passes:

1. **Read** `.dev-state/phase-{N}-review.md` — verify no BLOCKING issues
2. **Verify** all acceptance criteria are checked
3. **Verify** test suite passes
4. **Update** `.dev-state/progress.md` — set phase to APPROVED with timestamp
5. **Commit** with message: `phase(N): approve — <summary>`
6. **Comment** on GitHub issue #N with approval summary
7. **Announce** which phases are now unblocked

### `/phase-status`

Show current development status:

1. **Read** `.dev-state/progress.md`
2. Show table of all phases with status
3. Show which phases are READY (dependencies met, not started)
4. Show blockers if any

### `/test-send <message>`

Send a test WhatsApp message via ADB to verify the pipeline:

1. Target: `5543991938235` (ALWAYS this number)
2. Execute via ADB: intent → typing → send → screenshot
3. Save screenshot to `reports/test-send-{timestamp}.png`
4. Report success/failure with timing

### `/grill <topic>`

Stress-test a design decision before implementation:

1. Identify the topic (module, flow, edge case)
2. Ask adversarial questions:
   - "What if this fails mid-execution?"
   - "What if two workers race for the same message?"
   - "What if the device disconnects during typing?"
   - "What happens at 10x expected volume?"
3. Document findings in the phase review file
4. Block implementation until all concerns are resolved

## Code Conventions

### TypeScript
- Strict mode, no `any`
- Barrel exports per module (`index.ts`)
- Errors: custom error classes extending `DispatchError`
- Async/await, no callbacks
- Zod for runtime validation of API inputs

### Naming
- Files: `kebab-case.ts`
- Classes: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- DB tables: `snake_case`
- API routes: `kebab-case`

### Testing
- Test files: `*.test.ts` colocated with source
- Vitest as runner
- `describe` per public method, `it` per behavior
- Mock only at boundaries (ADB, HTTP, clock)
- No test should depend on another test
- No test should depend on real devices

### Git
- Branch per phase: `phase/N-short-description`
- Commits: `type(scope): message` — types: feat, fix, test, refactor, docs, chore
- PR per phase, reviewed before merge to main
- Never force-push main

### Logging
- pino with JSON output
- Every log MUST have `correlationId` for message tracking
- Levels: error (failures), warn (degraded), info (operations), debug (detail)

## Architecture Rules

1. **Core MUST work without Electron** — headless-first
2. **Core MUST work without any plugin** — plugins are optional extensions
3. **WAHA and Chatwoot are native** — they live in core, not plugins
4. **Every write operation MUST be idempotent** — use idempotency keys
5. **Every message MUST have an audit trail** — no fire-and-forget
6. **Rate limiting MUST match Oralsin WAHA client** — same algorithm, same config keys
7. **UI MUST consume only REST API + Socket.IO** — no direct DB access from renderer
8. **SQLite MUST use WAL mode** — concurrent reads during writes
9. **All credentials MUST be encrypted at rest** — never plaintext in SQLite or config

## Monorepo Structure (Target)

```
debt-adb-framework/
├── packages/
│   ├── core/                    # Headless engine
│   │   ├── src/
│   │   │   ├── adb/            # ADB Bridge (adbkit wrapper)
│   │   │   ├── queue/          # Message Queue (SQLite)
│   │   │   ├── engine/         # Send Engine (typing, validation)
│   │   │   ├── waha/           # WAHA Listener (passive)
│   │   │   ├── chatwoot/       # Chatwoot Bridge (bidirectional)
│   │   │   ├── monitor/        # Device Monitor (health, alerts)
│   │   │   ├── plugins/        # Plugin System (registry, events)
│   │   │   ├── api/            # REST API (Fastify routes)
│   │   │   ├── config/         # Configuration management
│   │   │   └── index.ts        # Entry point
│   │   ├── test/
│   │   └── package.json
│   ├── ui/                      # React SPA
│   │   ├── src/
│   │   │   ├── components/     # shadcn/ui components
│   │   │   ├── pages/          # Dashboard, Queue, Audit, Devices
│   │   │   ├── hooks/          # Socket.IO, API hooks
│   │   │   └── App.tsx
│   │   └── package.json
│   ├── electron/                # Electron shell
│   │   ├── src/
│   │   │   ├── main.ts         # Main process (loads core)
│   │   │   └── preload.ts
│   │   └── package.json
│   └── plugins/
│       └── oralsin/             # Oralsin NotificationBilling plugin
│           ├── src/
│           └── package.json
├── docs/
│   ├── PRD-dispatch.md
│   └── adr/                     # Architecture Decision Records
├── plans/
│   └── dispatch-implementation.md
├── scripts/                     # ADB utility scripts
├── .dev-state/                  # Development progress tracking
│   ├── progress.md              # Current state (survives context rot)
│   └── phase-N-review.md       # Per-phase review artifacts
├── CLAUDE.md                    # THIS FILE
├── turbo.json
├── package.json
└── .gitignore
```

## Recovery Checklist (After Context Rotation)

If you are starting a new session and this project is in context:

```markdown
## Quick Recovery Steps
1. cat .dev-state/progress.md          → Where are we?
2. cat plans/dispatch-implementation.md → What's the plan?
3. gh issue list --repo MrSchrodingers/debt-adb-framework → Open issues
4. git log --oneline -10               → Recent commits
5. npm test (if packages exist)        → Are tests passing?
6. Resume from progress.md current phase
```
