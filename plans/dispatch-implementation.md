# Plano: Dispatch — Multi-Device WhatsApp Orchestrator

> PRD de origem: `/var/www/adb_tools/docs/PRD-dispatch.md`
> Data: 2026-04-01
> Status: Pendente

## Decisoes Arquiteturais

Decisoes duraveis que se aplicam a TODAS as fases:

### Monorepo

```
amaral-dispatch/
  packages/
    core/        # Headless engine (Node.js + TypeScript)
    ui/          # React SPA (Tailwind + shadcn/ui)
    electron/    # Electron shell (importa core + serve ui)
    plugins/
      oralsin/   # Plugin Oralsin NotificationBilling
  turbo.json     # Turborepo pipeline
  package.json   # Workspace root
```

### REST API (core)

```
Base: http://localhost:7890/api/v1

POST   /messages                    # Enqueue message
GET    /messages/:id                # Get message status
GET    /messages?status=queued      # List messages

GET    /devices                     # List all devices
GET    /devices/:serial             # Device detail + health
POST   /devices/:serial/screenshot  # Take screenshot
POST   /devices/:serial/reboot     # Reboot device
POST   /devices/:serial/shell      # Execute ADB shell

GET    /whatsapp/accounts           # All WA accounts across devices
GET    /whatsapp/accounts/:number   # Account detail

GET    /health                      # Core health check
GET    /metrics                     # Prometheus-format metrics

# Plugin endpoints (dynamically registered)
POST   /plugins/:name/webhook       # Incoming webhook for plugin
```

### Schema SQLite (core)

Tabelas: `messages`, `message_history`, `devices`, `whatsapp_accounts`, `alerts`, `plugins`
(schema completo no PRD, secao "Modelo de Dados")

WAL mode habilitado. Idempotency via UNIQUE constraint em `idempotency_key`.
Locking via `UPDATE ... WHERE status='queued' LIMIT 1 RETURNING *` (SKIP LOCKED pattern).

### Locking Strategy (SQLite)

SQLite nao suporta SKIP LOCKED. Estrategia: `BEGIN IMMEDIATE` + CAS.

Dequeue atomico:
```sql
BEGIN IMMEDIATE;
UPDATE messages
  SET status = 'locked', locked_by = :device_serial, locked_at = datetime('now')
  WHERE id = (
    SELECT id FROM messages
    WHERE status = 'queued'
    ORDER BY priority ASC, created_at ASC
    LIMIT 1
  )
  RETURNING *;
COMMIT;
```

Stale lock cleanup (cron 30s):
```sql
UPDATE messages
  SET status = 'queued', locked_by = NULL, locked_at = NULL
  WHERE status = 'locked'
    AND locked_at < datetime('now', '-120 seconds');
```

### Rede e Endpoints

- Dispatch e Oralsin rodam em infra separada (internet)
- Dispatch exposto via reverse proxy + dominio + SSL (ex: dispatch.debt.com.br)
- Config: `DISPATCH_PUBLIC_URL` no .env — todos os webhook URLs derivam disso
- Callback delivery: at-least-once, 3 retries (5s, 15s, 45s), `failed_callbacks` table

### Trust Model

- Dispatch confia na Oralsin (executor burro)
- Valida schema (Zod) e aplica rate limit anti-ban
- Zero logica de negocio (weekly limit, template, paciente = Oralsin)

### Rate Limit — Valores Exatos (Port do WAHA Client Oralsin)

```
BASE_MIN_DELAY_S = 20.0
BASE_MAX_DELAY_S = 35.0
VOLUME_WINDOW_MINUTES = 60
VOLUME_SCALE_THRESHOLD = 10
VOLUME_SCALE_FACTOR = 1.5
VOLUME_MAX_DELAY_S = 120.0
PAIR_RATE_LIMIT_S = 6.0

Formula: scaled_delay = min(random(20, 35) * 1.5^(volume // 10), 120)
```

### Socket.IO Events (core → ui)

```
device:connected      {serial, brand, model}
device:disconnected   {serial}
device:health         {serial, ram, battery, temp, storage}
message:queued        {id, to, priority}
message:sending       {id, device_serial, sender_number}
message:sent          {id, sent_at, duration_ms}
message:failed        {id, error}
alert:new             {id, severity, type, message}
whatsapp:ban          {number, device_serial}
```

### Convencoes

- Logs: `pino` JSON com `correlation_id` por mensagem
- Config: `.env` + `dispatch.config.json` (overrides)
- Plugin interface: `DispatchPlugin { name, version, init(core), destroy() }`
- Event bus interno: EventEmitter com typed events
- Rate limiter: Port identico ao WAHA client da Oralsin (volume scaling exponencial)
- Typing: Gaussian random (media 80ms, desvio 30ms) por caracter

---

## Fase 1: Tracer Bullet — Uma Mensagem Ponta-a-Ponta

**User stories**: #1, #5, #9, #11, #12, #13, #14
**Estimativa**: G (1-2 semanas)
**Depende de**: Nenhuma

### O que construir

O caminho mais fino possivel que prova a arquitetura: conectar 1 device via ADB, enfileirar 1 mensagem via API, enviar via typing fisico no WhatsApp, confirmar envio, e mostrar na UI.

Ponta-a-ponta:
1. Core headless inicia, descobre 1 device via adbkit
2. API REST disponivel em localhost:7890
3. `POST /api/v1/messages` enfileira no SQLite
4. Worker dequeue, abre chat via `wa.me` intent, faz typing char-by-char, envia
5. Screenshot de validacao confirma envio
6. Status atualizado para `sent`
7. UI React minima mostra: 1 device card + fila de mensagens + status

### Criterios de aceitacao

- [ ] `npm run dev:core` inicia o core headless standalone
- [ ] `npm run dev:electron` inicia Electron com core embeddado + UI
- [ ] Device POCO Serenity detectado automaticamente ao conectar USB
- [ ] `POST /messages` retorna 201 com `message_id`
- [ ] `POST /messages` com mesmo `idempotency_key` retorna 409
- [ ] Mensagem enviada via ADB com typing visivel no device
- [ ] Screenshot capturado e salvo apos envio
- [ ] Status transiciona: queued → locked → sending → sent
- [ ] UI mostra device online + mensagem na fila + status sent
- [ ] Socket.IO emite eventos em cada transicao
- [ ] Testes: queue idempotency, lock exclusivity, send flow (mock ADB)
- [ ] Stale lock cleanup: mensagens locked > 120s voltam para queued
- [ ] Device `unauthorized` detectado na UI com instrucao para autorizar
- [ ] UI descobre core URL via injection (Electron) ou env var (web)

### Notas de implementacao

- Scaffold Turborepo com `packages/core`, `packages/ui`, `packages/electron`
- Core: Fastify + better-sqlite3 + adbkit + pino
- UI: Vite + React + Tailwind + shadcn/ui + Socket.IO client
- Electron: main process importa core, BrowserWindow carrega UI
- Send engine: usar `am start -a android.intent.action.VIEW -d "https://wa.me/{number}"` (sem coordenadas fixas)
- Typing: `adb shell input text` caracter por caracter com `setTimeout` gaussiano
- Validacao: screenshot + `sharp` para comparar regiao de check marks (template matching basico)

---

## Fase 2: Multi-Device + Health Monitoring

**User stories**: #1, #2, #4, #5, #6, #7, #27, #30
**Estimativa**: M (3-5 dias)
**Depende de**: Fase 1

### O que construir

Expandir de 1 device para N devices com discovery automatico, health polling, alertas, e grid visual.

1. Device Manager detecta novos devices via polling `adb devices` (5s interval)
2. Health collector poll cada device a cada 30s: RAM, bateria, temp, storage, WiFi
3. WhatsApp account mapper: detecta perfis de usuario + WA/WAB instalados
4. Alert system: thresholds configuraveis (bateria < 15%, RAM < 200MB, temp > 40C, offline)
5. UI: grid de devices com status real-time, alertas, health graphs (Recharts)

### Criterios de aceitacao

- [ ] Conectar/desconectar device reflete na UI em < 5s
- [ ] Health metrics atualizadas a cada 30s com historico de 24h
- [ ] Alertas gerados quando thresholds ultrapassados
- [ ] Mapa de contas WA: device → profile → app → numero
- [ ] Screenshot sob demanda de qualquer device
- [ ] Reboot remoto de device via UI
- [ ] Force-stop + restart WhatsApp via UI
- [ ] Testes: device discovery mock, alert thresholds, health persistence

### Notas de implementacao

- `adbkit.createClient().listDevices()` para discovery
- Health: `getprop`, `cat /proc/meminfo`, `dumpsys battery`, `dumpsys thermalservice`
- Accounts: `pm list packages --user N | grep whatsapp` para cada user profile
- Alerts: EventEmitter + persistencia em SQLite

---

## Fase 3: Send Engine Robusto + Anti-Ban

**User stories**: #10, #14, #15, #16, #17, #37, #38, #40, #41
**Estimativa**: G (1-2 semanas)
**Depende de**: Fase 2

### O que construir

Evoluir o send engine da Fase 1 para producao: rate limiting com volume scaling, distribuicao inteligente, ban detection, retry, e auto-recovery.

1. Rate limiter identico ao WAHA client Oralsin: delay base 20-35s, volume scaling exponencial, pair limit 6s, max 120s
2. Distribuicao round-robin ponderada: peso = health score × (1 / recent_send_count)
3. Ban detection: screenshot + Tesseract.js OCR para detectar "banned", "verify", CAPTCHA
4. Retry: mensagem volta para fila com `attempts++`, re-roteada para outro device/numero
5. Auto-recovery: WhatsApp crash → `am force-stop` + `am start` + retry
6. Contact registration: `am start -a INSERT -t vnd.android.cursor.dir/contact` antes do primeiro envio
7. Jitter entre mensagens: distribuicao exponencial 30s-5min

### Criterios de aceitacao

- [ ] Rate limit respeita 20-35s base com scaling exponencial identico a Oralsin
- [ ] Distribuicao balanceada entre numeros (max 10% desvio)
- [ ] Ban detectado em < 30s via OCR → numero pausado automaticamente
- [ ] Mensagem falhada re-enfileirada em < 5s com novo device
- [ ] WhatsApp crash recuperado automaticamente em < 15s
- [ ] Contact registration funcional para contatos novos
- [ ] Idempotencia preservada apos retries (mesmo idempotency_key)
- [ ] Testes: rate limiter timing, distribution fairness, ban detection (screenshot fixtures), retry flow

### Notas de implementacao

- Portar logica de `_apply_rate_limit` e `_get_volume_scale_factor` do WAHA client Oralsin para TypeScript
- OCR: Tesseract.js com modelo `eng` pre-carregado, crop da regiao central da tela
- Distribution: scoring function per-account, recalculado a cada dequeue
- OCR ban detection: crop centro da tela (25-75% width, 30-70% height)
- Strings de ban: ["banned", "suspended", "verify your phone", "unusual activity", "captcha"]
- Confidence threshold: >= 60% Tesseract
- Se OCR falha: nao pausar, logar warning, continuar
- Contact registration: intent ACTION_INSERT com EXTRA_PHONE + EXTRA_NAME
  Se contato ja existe: KEYCODE_BACK. Se falha: prosseguir via wa.me intent

---

## Fase 4: WAHA Listener Passivo

**User stories**: #18, #19, #20, #21, #42, #47
**Estimativa**: M (3-5 dias)
**Depende de**: Fase 1

### O que construir

Parear cada numero WhatsApp com uma sessao WAHA vinculada (linked device) em modo read-only para capturar ALL messages (incoming + outgoing via multi-device sync).

1. Session manager: para cada numero ativo, criar/verificar sessao WAHA via API
2. Webhook receiver: endpoint que recebe eventos do WAHA (message.received, message.sent)
3. Message history: persistir cada mensagem (in+out) em `message_history`
4. Health check: verificar sessoes WAHA periodicamente, re-parear se caiu
5. Independencia: ban da sessao WAHA NAO afeta envio ADB

### Criterios de aceitacao

- [ ] Sessao WAHA pareada automaticamente para cada numero ativo
- [ ] Mensagens incoming capturadas via webhook em < 10s
- [ ] Mensagens outgoing (enviadas via ADB) capturadas via multi-device sync
- [ ] Todas mensagens persistidas em `message_history` com metadata completo
- [ ] Sessao WAHA que cai eh re-pareada automaticamente
- [ ] Ban da sessao WAHA gera alerta mas NAO pausa envio ADB
- [ ] WAHA pairing retry: exponential backoff (5s, 10s, 20s, 40s, 80s) max 5x
- [ ] Outgoing capturada via multi-device sync em < 30s
- [ ] Queue NAO bloqueia esperando pairing (envia sem audit trail se necessario)
- [ ] Testes: webhook processing, session health check, independence from ADB

### Notas de implementacao

- Reutilizar fallback-manager do waha_poc para gerenciar sessoes
- Webhook: Fastify route `POST /api/v1/webhooks/waha`
- WAHA session config: `{"name": "{number}", "start": true}` com metadata `{"mode": "listener"}`

---

## Fase 5: Session Management + Inbox Automation

**User stories**: #22, #23, #24, #25, #26, #31
**Estimativa**: M (3-5 dias)
**Depende de**: Fase 4

### Scope Redefinition (Grill Result)

Original scope was "Chatwoot Bridge Bidirecional". Grill revealed that WAHA Plus already has
native Chatwoot App integration — all message bridging (incoming + outgoing via multi-device sync)
is already handled. Dispatch does NOT need to call Chatwoot API for messages.

New scope: manage WAHA sessions, automate inbox creation, provide admin UI.

### O que construir

1. Chatwoot HTTP Client: wrapper para API Chatwoot (criar/listar inboxes)
2. Managed Sessions: tabela separada para flag "managed" (participa do ADB dispatch)
3. Inbox Automation: orquestrar criacao de sessao WAHA + inbox Chatwoot em um fluxo
4. Session API: endpoints REST para gerenciar sessoes e exibir QR code
5. Admin UI: secao no Electron para listar sessoes, multi-select managed, QR code, criar inbox

### Criterios de aceitacao

- [ ] Chatwoot HTTP client funcional (criar inbox, listar inboxes)
- [ ] Tabela `managed_sessions` com CRUD completo
- [ ] Admin pode marcar/desmarcar sessoes como "managed" via UI
- [ ] Fluxo automatizado: criar inbox Chatwoot + configurar Chatwoot App no WAHA em um clique
- [ ] QR code exibido na UI via WAHA API (base64), status real-time via Socket.IO
- [ ] Sessoes managed participam do routing ADB; nao-managed sao ignoradas
- [ ] Managed flag permanente (nao auto-desmarca em falha de sessao/device)
- [ ] Testes: Chatwoot HTTP client mock, managed sessions CRUD, inbox creation orchestration

### Notas de implementacao

- Chatwoot: `chat.debt.com.br`, account_id=1, token via `CHATWOOT_API_TOKEN` env var
- WAHA Chatwoot App: configurar via `PUT /api/sessions/{name}/chatwoot`
- `managed_sessions` tabela separada de `whatsapp_accounts` (auto-discovered vs manual)
- Join: `managed_sessions.phone_number = whatsapp_accounts.phone_number`
- QR code: WAHA API retorna base64, status via webhook `session.status` → Socket.IO
- Inbox naming: auto-generated default pattern, editable by user
- Incoming/outgoing bridging NOT needed — WAHA native Chatwoot App handles it
- Operator replies NOT intercepted — continue via WAHA native path

---

## Fase 6: Dashboard Operacional

**User stories**: #27, #28, #29, #30, #31, #43, #45
**Estimativa**: M (3-5 dias)
**Depende de**: Fase 2, Fase 4

### O que construir

UI completa de operacao: graficos real-time, filas, audit trail, filtros, e painel de alertas.

1. Device grid: cards com RAM, bateria, temp, storage, contas WA, status, spark charts
2. Queue panel: mensagens pendentes/enviando/enviadas/falhadas com filtros e busca
3. Audit log: historico completo de mensagens (in+out) com busca por numero/data/status
4. Alert panel: lista de alertas ativos e resolvidos com severity
5. Metrics overview: taxa de sucesso, latencia media, volume hora/dia (Recharts)

### Criterios de aceitacao

- [ ] Dashboard atualiza em < 2s (Socket.IO push)
- [ ] Device grid mostra todos devices com health real-time
- [ ] Queue filtros: por status, numero, device, data
- [ ] Audit log buscavel por numero destino, remetente, data range
- [ ] Alertas com historico e acao de "resolver"
- [ ] Graficos de volume/sucesso por hora e dia
- [ ] Responsivo: funciona em Electron e browser (web)
- [ ] Testes: component tests (React Testing Library), Socket.IO event handling

### Notas de implementacao

- Recharts para graficos (line, bar, sparkline)
- shadcn/ui Table com sort/filter para filas e audit
- Socket.IO rooms por device serial para updates granulares
- Time series em SQLite: agregar por hora/dia para performance

---

## Fase 7: Plugin System + Plugin Oralsin

**User stories**: #9, #32, #33, #34, #35, #36, #44, #46
**Estimativa**: G (1-2 semanas)
**Depende de**: Fase 3, Fase 5

### O que construir

Sistema de plugins extensivel + primeiro plugin: Oralsin NotificationBilling.

**Plugin System:**
1. Plugin interface: `{ name, version, init(core), destroy(), routes?, webhooks?, events? }`
2. Plugin registry: load/unload/configure via SQLite + REST API
3. Event bus: plugins subscrevem a eventos do core (message:sent, message:failed, device:alert)
4. Route injection: plugins registram rotas adicionais no Fastify

**Plugin Oralsin:**
1. `DispatchNotifier(BaseNotifier)` no registry da Oralsin — novo adapter em `adapters/notifiers/dispatch/`
2. Traduz `WhatsappNotificationDTO` → `POST /api/v1/messages` do Dispatch
3. Callback receiver: `POST /api/webhooks/dispatch/` na Oralsin atualiza `ContactHistory`
4. Fallback chain: ADB (Dispatch) → WAHA API (direto) → SMS (Assertiva)
5. Respeita weekly limit (Redis da Oralsin — validacao no lado Oralsin, nao duplicar)

### Criterios de aceitacao

- [ ] Plugin carregado dinamicamente via config (sem rebuild do core)
- [ ] Plugin Oralsin enfileira mensagens no Dispatch via API
- [ ] Callback de status (sent/failed) atualiza ContactHistory na Oralsin
- [ ] Fallback ADB → WAHA funcional: se Dispatch falha 3x, tenta WAHA direto
- [ ] FlowStepConfig aceita channel="adb" mapeado para DispatchNotifier
- [ ] Event bus: plugin recebe eventos e pode reagir (ex: ban → pausar fila na Oralsin)
- [ ] Core funciona normalmente se plugin Oralsin nao estiver instalado
- [ ] Testes: plugin lifecycle, Oralsin adapter (mock Dispatch API), fallback chain

### Notas de implementacao

- Plugin Oralsin: pacote separado em `packages/plugins/oralsin/`
- DispatchNotifier na Oralsin: nova classe em `adapters/notifiers/dispatch/dispatch_notifier.py`
- Registry Oralsin: `get_notifier("adb") → DispatchNotifier`
- Callback: novo endpoint Django `POST /api/webhooks/dispatch/`
- Plugin event bus: DispatchEvent { type, timestamp, correlationId, data }
- Handlers async em try/catch isolado — erro no plugin NAO afeta core
- Timeout por handler: 5s
- Callback delivery: at-least-once, 3 retries, failed_callbacks table

---

## Fase 8: Multi-Profile + Hardening + Docker

**User stories**: #3, #8, #39, #40, #41, #43, #44, #45
**Estimativa**: G (1-2 semanas)
**Depende de**: Fase 3, Fase 6

### O que construir

Suporte completo a multi-profile (4 profiles por device = 8 WA por device), hardening para producao, e containerizacao Docker.

1. Multi-profile: `adb shell am start --user N` para alternar entre profiles, routing de mensagens por profile
2. Profile switching: lock por device (1 profile ativo por vez no send engine), queue por profile
3. Headless validation: core roda standalone sem Electron em Linux server
4. Docker: Dockerfile com ADB tools, USB passthrough via `--privileged` + `/dev/bus/usb`
5. Graceful shutdown: drain queue, finish current sends, persist state
6. Config management: `.env` + `dispatch.config.json` com hot-reload
7. Log rotation: pino com `pino-roll`
8. Encryption: credenciais em SQLite encriptadas com `better-sqlite3-encryption`

### Criterios de aceitacao

- [ ] 4 profiles de um device enviam mensagens corretamente (sem conflito)
- [ ] Profile switching atomico: lock por device impede envio simultaneo em 2 profiles
- [ ] `node packages/core/dist/index.js` roda headless em Linux sem Electron
- [ ] `docker build` + `docker run --privileged` detecta devices USB
- [ ] Ctrl+C → graceful shutdown em < 10s (drain + persist)
- [ ] Credenciais WAHA/Chatwoot encriptadas no SQLite
- [ ] Logs rotacionados, max 50MB por arquivo, 5 backups
- [ ] Testes: multi-profile lock, graceful shutdown, headless mode

### Notas de implementacao

- Profile switching: `adb shell am switch-user N` + wait + verify
- Docker: base `node:22-slim`, install `android-tools`, mount `/dev/bus/usb`
- Graceful: `process.on('SIGINT')` → stop accepting, drain queue, close SQLite
- Encryption key: derivada de machine-id via PBKDF2 (nunca salva em disco)
- Se trocar maquina: re-configurar credenciais

---

## Resumo

| Fase | Titulo | Stories | Estimativa | Depende de |
|------|--------|---------|------------|------------|
| 1 | Tracer Bullet — 1 mensagem ponta-a-ponta | #1,5,9,11,12,13,14 | G | - |
| 2 | Multi-Device + Health Monitoring | #1,2,4,5,6,7,27,30 | M | Fase 1 |
| 3 | Send Engine Robusto + Anti-Ban | #10,14-17,37,38,40,41 | G | Fase 2 |
| 4 | WAHA Listener Passivo | #18-21,42,47 | M | Fase 1 |
| 5 | Chatwoot Bridge Bidirecional | #22-26,31 | M | Fase 4 |
| 6 | Dashboard Operacional | #27-31,43,45 | M | Fase 2, 4 |
| 7 | Plugin System + Plugin Oralsin | #9,32-36,44,46 | G | Fase 3, 5 |
| 8 | Multi-Profile + Hardening + Docker | #3,8,39-41,43-45 | G | Fase 3, 6 |

### Grafo de Dependencias

```
Fase 1 (Tracer Bullet)
  ├── Fase 2 (Multi-Device)
  │     ├── Fase 3 (Send Engine)
  │     │     ├── Fase 7 (Plugins + Oralsin) ←── Fase 5
  │     │     └── Fase 8 (Hardening)  ←── Fase 6
  │     └── Fase 6 (Dashboard) ←── Fase 4
  └── Fase 4 (WAHA Listener)
        └── Fase 5 (Chatwoot Bridge)
```

### Caminho Critico

```
Fase 1 → Fase 2 → Fase 3 → Fase 7 (Plugin Oralsin = primeiro teste real)
```

As Fases 4/5 (WAHA+Chatwoot) rodam em paralelo com 2/3 e convergem na Fase 7.

---

## Proximos Passos

1. ✅ Aprovar este plano
2. Criar repositorio GitHub `amaral-dispatch`
3. `/prd-to-issues` — criar issues a partir das fases
4. Implementar Fase 1 via `/tdd`
