# PRD: Dispatch — Multi-Device WhatsApp Orchestrator

> **Codename:** Dispatch
> **Status:** Draft
> **Autor:** Principal Architect + AI
> **Data:** 2026-04-01

---

## Declaracao do Problema

### Quem sofre

Operadores de cobranca e notificacao da Oralsin que dependem de envio massivo de mensagens WhatsApp para lembretes de pagamento (adimplentes e inadimplentes) em escala de milhares de contatos/dia.

### Impacto atual

1. **Banimento recorrente**: A stack WAHA (GoWS/WEBJS) perde fingerprints que a Meta detecta como comportamento nao-humano. Sessoes WebSocket sao banidas, derrubando numeros ativos e interrompendo campanhas de cobranca em andamento.

2. **Custo operacional de ban**: Cada ban significa: (a) perda do numero, (b) reativacao manual de sessao, (c) necessidade de novo chip/numero, (d) interrupcao do fluxo de cobranca por horas/dias, (e) perda de historico de conversa.

3. **Sem visibilidade unificada**: Hoje nao ha dashboard centralizado que mostre: quais celulares estao ativos, qual o estado de cada WhatsApp, qual a saude do device (RAM, bateria, storage), e o historico completo de mensagens de todas as contas.

4. **Sem auditoria completa**: O contexto de cobranca exige compliance — registro integral de todas as conversas (outgoing e incoming), com rastreabilidade para defesa em disputas juridicas. A captura atual via WAHA e parcial e fragil.

5. **Escala limitada**: Sem orquestracao multi-device, o volume de envios por numero atinge rate limits rapidamente, concentrando carga em poucos numeros e aumentando o risco de ban.

### Volume esperado

- 2 devices iniciais (POCO Serenity + 1 adicional)
- 4 perfis por device = 8-16 contas WhatsApp
- Escala para 30+ devices no curto prazo
- Volume: 500-5.000 mensagens/dia distribuidas entre os numeros
- Canais: WhatsApp (primario), com SMS/Email como fallback via Oralsin

---

## Solucao Proposta

**Dispatch** eh um desktop app Electron que controla dispositivos Android fisicos via ADB para envio de mensagens WhatsApp com comportamento indistinguivel de um humano. Integra-se nativamente com Chatwoot (inbox bidirecional) e WAHA (listener passivo para captura de mensagens), e recebe workloads de sistemas externos via plugin architecture.

### Arquitetura Hibrida ADB+WAHA

```
                  OUTBOUND (anti-ban)          INBOUND (audit completo)
                  ─────────────────           ──────────────────────
                        │                              │
                   ADB Typing                   WAHA Webhook
                   (fisico no device)           (multi-device listener)
                        │                              │
                        ▼                              ▼
                  ┌──────────┐                  ┌──────────┐
                  │ Device   │ ◄── same ───►    │ WAHA     │
                  │ WhatsApp │     number        │ Session  │
                  │ (phone)  │     paired        │ (web)    │
                  └──────────┘                  └──────────┘
                        │                              │
                        └──────────┬───────────────────┘
                                   │
                                   ▼
                            ┌──────────────┐
                            │   Chatwoot   │
                            │  (inbox      │
                            │   unificado) │
                            └──────────────┘
```

**Por que essa separacao:**
- **ADB para outbound**: O envio fisico no device preserva TODAS as fingerprints (device ID, SIM, IP celular, touch patterns, timing). A Meta nao consegue distinguir de uso humano.
- **WAHA para inbound**: O WhatsApp Multi-Device sincroniza mensagens entre phone e web session. A sessao WAHA vinculada como "linked device" captura TODAS as mensagens (incoming + outgoing enviados pelo phone) via webhook, sem enviar nada. Modo read-only minimiza risco de ban na sessao web.
- **Chatwoot como hub**: Todas as mensagens (in+out) convergem no Chatwoot, dando ao operador visao completa e permitindo resposta manual ou futura integracao com agent bot.

### Beneficios esperados

1. **Reducao de 90%+ no risco de ban** (envio fisico vs WebSocket)
2. **Auditoria 100%** de todas as conversas (compliance para cobranca)
3. **Dashboard operacional** com saude dos devices em tempo real
4. **Distribuicao inteligente** de carga entre numeros/devices
5. **Resiliencia**: se um device cai, mensagens re-roteiam para outro
6. **Escalabilidade horizontal**: adicionar device = plugar USB

---

## User Stories

### Core — Device Management
1. Como operador, quero ver todos os devices conectados com status real-time (online/offline, bateria, RAM, storage, temperatura), para saber se minha infraestrutura esta saudavel.
2. Como operador, quero receber alertas quando um device ficar offline, bateria < 15%, RAM critica, ou WhatsApp crashar, para agir antes que afete envios.
3. Como operador, quero ver um screenshot sob demanda de qualquer device, para diagnosticar problemas visuais.
4. Como operador, quero reiniciar um device ou forcar stop/restart do WhatsApp remotamente, para recuperar de travamentos.
5. Como sistema, quero detectar automaticamente novos devices conectados via USB e registra-los no grid, para que plugar um device novo seja zero-config.

### Core — WhatsApp Account Map
6. Como operador, quero ver um mapa de todas as contas WhatsApp ativas (device → perfil → WA/WAB → numero), para saber qual numero esta em qual device.
7. Como operador, quero ver o status de cada numero (ativo, banido, verificacao pendente, rate-limited), para rotacionar numeros proativamente.
8. Como sistema, quero detectar automaticamente quando um numero eh banido (via screenshot+OCR ou notification listener), para pausar envios naquele numero e alertar o operador.

### Core — Message Queue & Dispatch
9. Como sistema externo (plugin), quero enfileirar mensagens via REST API com: numero destino, texto, prioridade, metadata, para que o Dispatch as despache via ADB.
10. Como Dispatch, quero distribuir mensagens entre os numeros disponiveis usando round-robin ponderado (peso por health score do device + rate limit do numero), para balancear carga e minimizar ban.
11. Como Dispatch, quero garantir idempotencia de envio usando chave unica (schedule_id + channel + attempt), para que reprocessamento nao cause duplicatas.
12. Como Dispatch, quero implementar locking pessimista por mensagem (similar ao SKIP LOCKED do Oralsin), para que dois workers nunca processem a mesma mensagem.
13. Como Dispatch, quero registrar cada envio com: timestamp, device, numero remetente, numero destino, status (sent/failed/retrying), duracao, para auditoria completa.

### Core — Natural Sending Flow
14. Como Dispatch, quero enviar mensagens com fluxo natural: (a) registrar contato se novo, (b) abrir chat via wa.me intent, (c) tap no campo de texto, (d) typing char-by-char com delays gaussianos (media 80ms, desvio 30ms), (e) pausa de releitura (1-3s), (f) tap em enviar, (g) validar envio via screenshot, para simular comportamento humano real.
15. Como Dispatch, quero aplicar jitter entre mensagens (30s-5min, distribuicao exponencial inversamente proporcional ao volume), para evitar padrao detectavel.
16. Como Dispatch, quero aplicar rate limiting por numero (max N msgs/hora) com volume scaling (delay cresce exponencialmente com volume, identico ao WAHA client da Oralsin), para anti-ban.
17. Como Dispatch, quero pausar automaticamente um numero se detectar CAPTCHA, verificacao telefonica, ou tela de ban, para evitar perda do numero.

### Core — WAHA Integration (Native — Listener Passivo)
18. Como Dispatch, quero parear cada numero de WhatsApp com uma sessao WAHA vinculada (linked device) em modo read-only, para capturar todas as mensagens via webhook sem enviar nada pela sessao web.
19. Como Dispatch, quero receber webhooks do WAHA com mensagens incoming E outgoing (sincronizadas via multi-device), para ter historico completo.
20. Como Dispatch, quero health-check periodico das sessoes WAHA e re-parear automaticamente se a sessao web cair, para manter captura continua.
21. Como Dispatch, quero que se a sessao WAHA de um numero for banida, isso NAO afete o envio ADB (sao independentes), e quero ser alertado para re-parear.

### Core — Chatwoot Integration (Native — Inbox Bidirecional)
22. Como Dispatch, quero criar/atualizar contatos no Chatwoot quando uma conversa eh iniciada, para manter o inbox sincronizado.
23. Como Dispatch, quero encaminhar todas as mensagens incoming (capturadas via WAHA webhook) para a conversa correspondente no Chatwoot, para que operadores vejam respostas dos clientes.
24. Como Dispatch, quero encaminhar todas as mensagens outgoing (enviadas via ADB, confirmadas via WAHA sync) para o Chatwoot, para historico completo.
25. Como operador no Chatwoot, quero responder a uma conversa e ter a resposta despachada via ADB no device correto, para interacao manual quando necessario.
26. Como Dispatch, quero mapear cada numero WhatsApp para uma inbox no Chatwoot, para que conversas fiquem organizadas por numero/device.

### Core — Monitoring Dashboard (UI)
27. Como operador, quero um dashboard com graficos real-time de: RAM, bateria, temperatura, storage por device, para monitoramento continuo.
28. Como operador, quero ver o status da fila de mensagens: pendentes, enviando, enviadas, falhas, por numero e por device, para acompanhar campanhas.
29. Como operador, quero ver taxa de sucesso de envio, latencia media, e volume por hora/dia, para avaliar performance.
30. Como operador, quero ver um log de alertas com historico e severidade, para investigar incidentes.
31. Como operador, quero filtrar/buscar mensagens por numero destino, data, status, para audit trail.

### Plugin — Oralsin Notifier (Primeiro Plugin)
32. Como Oralsin API, quero enviar schedules de notificacao para o Dispatch via REST API usando o contrato existente (WhatsappNotificationDTO), para migrar o canal de WAHA direto para ADB sem mudar a logica de negocio.
33. Como Oralsin API, quero receber callback de status (sent/failed/delivered) do Dispatch via webhook, para atualizar ContactHistory com outcome e outcome_reason.
34. Como Oralsin API, quero que o Dispatch respeite o weekly limit (1 msg/semana/paciente/canal) que ja eh controlado no Redis da Oralsin, para nao duplicar validacao.
35. Como Dispatch, quero que se o envio ADB falhar apos N retries, fazer fallback para WAHA API (canal secundario), para nao perder a notificacao.
36. Como Oralsin API, quero que o plugin traduza o FlowStepConfig.channels["adb"] para dispatch via Electron, mantendo compatibilidade com o registry pattern existente.

### Resiliencia & Edge Cases
37. Como Dispatch, quero que se um device desconectar no meio de um envio, a mensagem volte para a fila com status "retrying" e seja re-roteada para outro device, para nao perder mensagens.
38. Como Dispatch, quero que se o app WhatsApp crashar no device, ele seja reiniciado automaticamente via ADB intent e o envio retomado, para auto-recuperacao.
39. Como Dispatch, quero que se TODOS os devices estiverem offline, as mensagens fiquem na fila com TTL configuravel e alertas sejam disparados, para o operador agir.
40. Como Dispatch, quero rate limiting global (max msgs/minuto cross-device) configuravel, para controle total de velocidade.
41. Como Dispatch, quero que o envio de cada mensagem seja atomico e idempotente — se o processo morrer no meio, o estado fica consistente no restart.

### Seguranca & Compliance
42. Como auditor, quero que TODAS as mensagens (in+out) sejam persistidas com timestamp, remetente, destinatario, conteudo, device, e status, para compliance de cobranca.
43. Como sistema, quero que credenciais (API keys WAHA, Chatwoot tokens) sejam armazenadas encriptadas no SQLite local, para seguranca.
44. Como admin, quero configurar quais numeros podem enviar e para quais faixas de DDDs, para controle operacional.
45. Como sistema, quero logs estruturados (JSON) com correlation_id por mensagem, para rastreabilidade end-to-end.

### Futuro (Fora de Escopo mas Preparar)
46. Como sistema, quero que a arquitetura suporte attach de um agent bot (LLM) que receba o contexto completo da conversa + dados do contrato, para resposta automatizada futura.
47. Como sistema, quero que a captura de mensagens incoming inclua metadata suficiente (timestamp, remetente, texto completo, media type) para treinar/alimentar o agent bot.

---

## Criterios de Aceitacao

### Funcionalidade
- [ ] Device auto-discovery detecta novo device em < 5s apos conexao USB
- [ ] Health polling a cada 30s com metricas: RAM, bateria, temp, storage, WiFi, WhatsApp status
- [ ] Envio natural com typing char-by-char, delays gaussianos, e jitter entre mensagens
- [ ] Screenshot de validacao apos cada envio com deteccao de sucesso (check marks)
- [ ] Ban detection via screenshot+OCR com pausar automatica do numero em < 30s
- [ ] Idempotencia: reprocessar mesma mensagem (mesmo schedule_id) nao gera duplicata
- [ ] Locking: duas instancias do worker nunca processam a mesma mensagem simultaneamente
- [ ] Distribuicao round-robin ponderada entre numeros disponiveis
- [ ] Fallback ADB → WAHA funcional quando configurado

### Performance
- [ ] Throughput: 1 mensagem a cada 20-120s por numero (rate limited para anti-ban)
- [ ] Throughput agregado: com 8 numeros paralelos, ~15-25 msgs/min
- [ ] Latencia de deteccao de device offline: < 10s
- [ ] UI dashboard atualiza em < 2s (via Socket.IO)
- [ ] Startup do app: < 5s ate tela funcional

### Resiliencia
- [ ] Device disconnect mid-send: mensagem re-enfileirada em < 5s
- [ ] WhatsApp crash: auto-restart via intent em < 15s
- [ ] WAHA session drop: alerta + tentativa de re-parear em < 60s
- [ ] Todos devices offline: fila preservada, alerta imediato, envio retomado no reconnect
- [ ] App crash/restart: estado consistente, fila intacta, envios retomados

### Observabilidade
- [ ] Logs estruturados JSON com: correlation_id, device_serial, phone_number, action, duration_ms
- [ ] Metricas exportaveis: msgs_sent, msgs_failed, device_health, queue_depth
- [ ] Historico de alertas persistido localmente
- [ ] Audit trail completo: quem enviou, para quem, quando, de qual device, qual numero, conteudo, status

### Chatwoot
- [ ] Mensagens incoming aparecem no Chatwoot em < 10s apos recepcao no device
- [ ] Mensagens outgoing (ADB) aparecem no Chatwoot em < 30s (via WAHA multi-device sync)
- [ ] Resposta do operador via Chatwoot despachada via ADB em < 60s
- [ ] Cada numero mapeado para uma inbox Chatwoot

---

## Decisoes de Implementacao

### Arquitetura Core

**Plugin Architecture (Port & Adapter, inspirada na Oralsin)**:

```
┌─────────────────────────────────────────────────────────────────┐
│                        DISPATCH CORE                             │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Plugin Registry                        │   │
│  │  register(name, adapter) / get(name) / list()            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                           │                                      │
│    ┌──────────────────────┼──────────────────────┐              │
│    │                      │                      │              │
│    ▼                      ▼                      ▼              │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────┐         │
│  │ ADB      │    │ WAHA         │    │ Chatwoot      │         │
│  │ Engine   │    │ Listener     │    │ Bridge        │         │
│  │ (native) │    │ (native)     │    │ (native)      │         │
│  └──────────┘    └──────────────┘    └───────────────┘         │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                Message Queue (SQLite)                     │   │
│  │  enqueue / dequeue / ack / nack / retry / status          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Device Manager (ADB Bridge)                  │   │
│  │  discover / connect / health / screenshot / input / shell │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                REST API (localhost)                        │   │
│  │  /devices  /queue  /send  /health  /whatsapp/accounts    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
        │                                          │
        │ Plugin Interface                         │ Plugin Interface
        ▼                                          ▼
┌──────────────────┐                    ┌──────────────────┐
│ Oralsin Plugin   │                    │ Future Plugin    │
│ (notification    │                    │ (AI Agent Bot,   │
│  billing bridge) │                    │  Campaign Mgr,   │
│                  │                    │  Analytics, ...) │
└──────────────────┘                    └──────────────────┘
```

### Modulos Profundos

**1. ADB Bridge** (Deep Module)
- Interface: `discover()`, `getDevice(serial)`, `health(serial)`, `screenshot(serial)`, `input(serial, cmd)`, `shell(serial, cmd)`
- Implementacao: `adbkit` (protocolo ADB nativo Node.js), device pool, reconnect logic, health polling loop
- Responsabilidade unica: abstrai TODA a comunicacao ADB

**2. Message Queue** (Deep Module)
- Interface: `enqueue(msg)`, `dequeue(deviceSerial)`, `ack(msgId)`, `nack(msgId, reason)`, `getStatus(msgId)`
- Implementacao: SQLite com WAL mode, SKIP LOCKED emulation, TTL, priority queue, idempotency check via unique constraint
- Responsabilidade unica: persistencia e distribuicao de mensagens

**3. Send Engine** (Deep Module)
- Interface: `sendMessage(device, contact, text)` → `Promise<SendResult>`
- Implementacao: fluxo natural completo (contact registration → intent → typing → screenshot validation → send confirmation), rate limiting (volume scaling identico ao WAHA client Oralsin), ban detection
- Responsabilidade unica: executa o envio fisico com comportamento humano

**4. WAHA Listener** (Deep Module)
- Interface: `pairSession(phoneNumber)`, `unpairSession(phoneNumber)`, `onMessage(callback)`
- Implementacao: gerencia sessoes WAHA vinculadas, recebe webhooks, sincroniza status
- Responsabilidade unica: captura de mensagens via WAHA multi-device

**5. Chatwoot Bridge** (Deep Module)
- Interface: `syncMessage(msg)`, `onOperatorReply(callback)`, `createInbox(phoneNumber)`
- Implementacao: API client Chatwoot, webhook receiver, contact/conversation sync
- Responsabilidade unica: sincronizacao bidirecional com Chatwoot

**6. Plugin System** (Deep Module)
- Interface: `register(plugin)`, `emit(event, data)`, `on(event, callback)`
- Implementacao: event bus, plugin lifecycle (load/unload/configure), REST API exposure
- Responsabilidade unica: extensibilidade sem modificar o core

**7. Device Monitor** (Deep Module)
- Interface: `getMetrics(serial)`, `onAlert(callback)`, `getHistory(serial, timeRange)`
- Implementacao: polling loop, threshold-based alerts, in-memory time series + SQLite persistence
- Responsabilidade unica: monitoramento e alerting

### Headless-First Architecture

O Dispatch eh **headless-first**: o core roda como processo Node.js puro (sem Electron)
expondo REST API + Socket.IO. A UI eh uma camada separada que consome essas APIs.

```
┌─────────────────────────────────────────────────────────┐
│                   UI LAYER (separada)                     │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Electron     │  │ Web App      │  │ Future:      │  │
│  │ (desktop)    │  │ (browser)    │  │ Mobile/CLI   │  │
│  │              │  │              │  │              │  │
│  │ Embeds core  │  │ Connects via │  │ Connects via │  │
│  │ + renderer   │  │ REST+WS     │  │ REST+WS     │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│          │                  │                │           │
│          └──────────┬───────┘────────────────┘           │
│                     │                                    │
│              REST API + Socket.IO                        │
│                                                          │
└─────────────────────────────────────────────────────────┘
                      │
┌─────────────────────┴───────────────────────────────────┐
│                   CORE (headless)                         │
│                                                          │
│  Node.js process — roda standalone ou embeddado          │
│  no main process do Electron                             │
│                                                          │
│  - ADB Bridge                                            │
│  - Message Queue (SQLite)                                │
│  - Send Engine                                           │
│  - WAHA Listener                                         │
│  - Chatwoot Bridge                                       │
│  - Plugin System                                         │
│  - Device Monitor                                        │
│  - REST API (Express/Fastify)                            │
│  - Socket.IO server                                      │
│                                                          │
│  Modos de execucao:                                      │
│  1. Electron: core embeddado no main process             │
│  2. Headless: `node dispatch-core.js` (servidor/CI)      │
│  3. Docker: container com ADB passthrough (USB)          │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

**Separacao de pacotes:**
```
packages/
  core/          # Headless engine (publicavel como npm package)
  ui/            # React app (SPA, renderiza em Electron ou browser)
  electron/      # Electron shell (importa core + serve ui)
  plugins/       # Plugin packages (oralsin, etc)
```

**Beneficios:**
1. **Servidor**: Roda headless em Linux server com USB hubs, operadores acessam via web
2. **Desktop**: Electron embeda core + UI para uso local
3. **Port para web**: UI React ja eh web-native, basta apontar para URL do core
4. **Docker**: Core em container com `--privileged` para ADB USB passthrough
5. **Testabilidade**: Core testavel sem Electron/browser

### Stack Tecnico

| Camada | Tecnologia | Justificativa |
|--------|-----------|---------------|
| Core | Node.js 22 + TypeScript | Headless, embeddavel em Electron |
| API | Fastify 5 | Mais rapido que Express, schema validation nativo |
| Real-time | Socket.IO | Push events core → UI |
| ADB | adbkit (npm) | Protocolo ADB nativo, sem shell out |
| DB local | better-sqlite3 (WAL mode) | Fila, historico, config — zero infra |
| Screenshot | sharp | Image processing para template matching |
| OCR | Tesseract.js | Ban/CAPTCHA detection |
| Scheduling | node-cron | Health check loops |
| HTTP client | undici | Chamadas WAHA/Chatwoot |
| Logs | pino (JSON) | Estruturado, performatico |
| Desktop | Electron 33+ | Shell para core + UI |
| Frontend | React 19 + TypeScript | SPA consumindo REST + Socket.IO |
| UI Kit | Tailwind CSS + shadcn/ui | Consistente com stack Oralsin |
| Graficos | Recharts | Leve, React-native |
| Monorepo | Turborepo | Build pipeline para core/ui/electron/plugins |

### Contratos de API (REST Local)

**Enqueue Message** (chamado pelos plugins):
```
POST /api/v1/messages
{
  "idempotency_key": "schedule_123_whatsapp_1",
  "to": "5543999999999",
  "text": "Ola {{nome}}, lembrete da parcela...",
  "priority": "normal",           // "high" | "normal" | "low"
  "metadata": {                   // passthrough para callback
    "schedule_id": "uuid",
    "patient_id": "uuid",
    "plugin": "oralsin"
  },
  "callback_url": "http://oralsin:8000/api/webhooks/dispatch/",
  "preferred_sender": null,       // null = auto-distribute
  "ttl_minutes": 1440             // expira em 24h se nao enviada
}

Response 201:
{
  "message_id": "uuid",
  "status": "queued",
  "estimated_send_at": "2026-04-01T14:30:00Z"
}

Response 409 (idempotent):
{
  "message_id": "uuid",
  "status": "already_queued",
  "original_queued_at": "2026-04-01T14:00:00Z"
}
```

**Callback Webhook** (Dispatch → Plugin):
```
POST {callback_url}
{
  "message_id": "uuid",
  "idempotency_key": "schedule_123_whatsapp_1",
  "status": "sent",              // "sent" | "failed" | "expired" | "banned"
  "sent_at": "2026-04-01T14:32:15Z",
  "duration_ms": 12500,
  "device_serial": "9b010059...",
  "sender_number": "5543988887777",
  "error": null,                 // ou "ban_detected", "captcha", "device_offline"
  "metadata": { ... }            // passthrough original
}
```

**List Devices**:
```
GET /api/v1/devices

Response 200:
{
  "devices": [
    {
      "serial": "9b010059...",
      "brand": "POCO",
      "model": "25028PC03G",
      "status": "online",
      "battery": 97,
      "ram_available_mb": 1425,
      "storage_free_pct": 76,
      "temperature_c": 24.9,
      "whatsapp_accounts": [
        {"profile_id": 0, "type": "whatsapp", "number": "5543999001234", "status": "active"},
        {"profile_id": 0, "type": "whatsapp_business", "number": "5543988887777", "status": "active"}
      ],
      "queue_depth": 12,
      "last_send_at": "2026-04-01T14:30:00Z"
    }
  ]
}
```

### Integracao Oralsin (Plugin)

O plugin Oralsin implementa a interface de plugin e registra um novo notifier no registry da Oralsin:

```
Oralsin Registry:
  channel="adb" → DispatchNotifier(BaseNotifier)
    └── send(WhatsappNotificationDTO) → POST Dispatch /api/v1/messages
    └── on_callback(webhook) → update ContactHistory(outcome, outcome_reason)
```

O `DispatchNotifier` sera uma nova classe em `/src/notification_billing/adapters/notifiers/dispatch/` que:
1. Traduz `WhatsappNotificationDTO` para o contrato REST do Dispatch
2. Enfileira via `POST /api/v1/messages` com `idempotency_key = schedule_id + channel + step`
3. Recebe callback via webhook endpoint na Oralsin
4. Atualiza `ContactHistory` com outcome (SUCCESS/ERROR/BLOCKED) e `outcome_reason`
5. Se fallback configurado: tenta WAHA direto apos N falhas do Dispatch

Fallback chain: `ADB (Dispatch) → WAHA API (direto) → SMS (Assertiva)`

### Message Flow Completo (Oralsin → Device → Chatwoot)

```
1. Oralsin RunAutomatedNotifications
   │
2. CommandBus → SendManualNotificationHandler
   │
3. Registry.get_notifier("adb") → DispatchNotifier
   │
4. DispatchNotifier.send(dto)
   │  POST /api/v1/messages {idempotency_key, to, text, callback_url}
   │
5. Dispatch enqueue (SQLite, SKIP LOCKED)
   │
6. Worker dequeue → pick best device/number (round-robin ponderado)
   │
7. Send Engine: register contact → open chat → typing → send → validate
   │
8. Dispatch callback → POST oralsin/webhooks/dispatch/ {status: "sent"}
   │
9. Oralsin updates ContactHistory(outcome=SUCCESS)
   │
10. [Meanwhile] WAHA multi-device sync captures outgoing message
    │
11. WAHA webhook → Dispatch → Chatwoot: create/update conversation
    │
12. [Later] Client responds on WhatsApp
    │
13. WAHA webhook → Dispatch → Chatwoot: incoming message
    │
14. Operador ve conversa completa no Chatwoot
    │
15. [Opcional] Operador responde via Chatwoot → Dispatch → ADB typing no device
```

### Modelo de Dados (SQLite)

```sql
-- Fila de mensagens
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,
  to_number TEXT NOT NULL,
  text TEXT NOT NULL,
  priority INTEGER DEFAULT 1,      -- 0=high, 1=normal, 2=low
  status TEXT DEFAULT 'queued',     -- queued|locked|sending|sent|failed|expired
  locked_by TEXT,                   -- device_serial que pegou
  locked_at TEXT,                   -- timestamp do lock
  device_serial TEXT,               -- device que enviou
  sender_number TEXT,               -- numero que enviou
  callback_url TEXT,
  metadata TEXT,                    -- JSON blob passthrough
  error TEXT,
  ttl_expires_at TEXT,
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  updated_at TEXT
);
CREATE INDEX idx_messages_status ON messages(status, priority, created_at);
CREATE INDEX idx_messages_locked ON messages(locked_by, status);

-- Historico de mensagens (audit trail)
CREATE TABLE message_history (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  direction TEXT NOT NULL,           -- outgoing|incoming
  from_number TEXT,
  to_number TEXT,
  text TEXT,
  media_type TEXT,
  device_serial TEXT,
  profile_id INTEGER,
  waha_message_id TEXT,
  chatwoot_message_id INTEGER,
  captured_via TEXT,                  -- adb_send|waha_webhook|chatwoot_reply
  created_at TEXT NOT NULL
);
CREATE INDEX idx_history_numbers ON message_history(from_number, to_number, created_at);

-- Devices
CREATE TABLE devices (
  serial TEXT PRIMARY KEY,
  brand TEXT,
  model TEXT,
  android_version TEXT,
  status TEXT DEFAULT 'offline',
  last_health_at TEXT,
  health_data TEXT,                  -- JSON: ram, battery, temp, storage
  created_at TEXT,
  updated_at TEXT
);

-- WhatsApp accounts
CREATE TABLE whatsapp_accounts (
  id TEXT PRIMARY KEY,
  device_serial TEXT NOT NULL REFERENCES devices(serial),
  profile_id INTEGER NOT NULL,
  app_type TEXT NOT NULL,            -- whatsapp|whatsapp_business
  phone_number TEXT NOT NULL,
  status TEXT DEFAULT 'active',      -- active|banned|verifying|rate_limited
  waha_session_name TEXT,            -- linked WAHA session
  chatwoot_inbox_id INTEGER,
  daily_sent_count INTEGER DEFAULT 0,
  last_sent_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(device_serial, profile_id, app_type)
);
CREATE INDEX idx_wa_status ON whatsapp_accounts(status, phone_number);

-- Alertas
CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  device_serial TEXT,
  severity TEXT NOT NULL,            -- critical|high|medium|low
  type TEXT NOT NULL,                -- battery_low|device_offline|ban_detected|...
  message TEXT NOT NULL,
  resolved BOOLEAN DEFAULT FALSE,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

-- Plugins
CREATE TABLE plugins (
  name TEXT PRIMARY KEY,
  version TEXT,
  enabled BOOLEAN DEFAULT TRUE,
  config TEXT,                       -- JSON
  created_at TEXT,
  updated_at TEXT
);
```

---

## Decisoes de Teste

### Filosofia
- Testar comportamento externo, nao detalhes de implementacao
- Mock apenas em fronteiras: ADB (mock adbkit), WAHA API, Chatwoot API
- Tests rodam sem devices fisicos conectados

### Cobertura por Modulo
| Modulo | Tipo | Mock |
|--------|------|------|
| Message Queue | Unitario | SQLite in-memory |
| Send Engine | Unitario | Mock ADB Bridge |
| Rate Limiter | Unitario | Mock clock |
| WAHA Listener | Integracao | Mock HTTP |
| Chatwoot Bridge | Integracao | Mock HTTP |
| Plugin System | Unitario | Mock plugins |
| REST API | Integracao | Supertest |
| Device Manager | Unitario | Mock adbkit |

### Infraestrutura
- Vitest como test runner (rapido, ESM nativo)
- SQLite `:memory:` para testes de fila
- msw (Mock Service Worker) para HTTP mocks
- Fixtures: device info, WhatsApp screenshots, WAHA payloads

---

## Analise de Riscos

| Risco | Probabilidade | Impacto | Mitigacao |
|-------|--------------|---------|-----------|
| WhatsApp ban mesmo com ADB | Baixa | Alto | Volume scaling, jitter, rotacao de numeros, delay gaussiano |
| Coordenadas de UI variam por device/versao WA | Alta | Medio | wa.me intent (sem coordenadas), screenshot validation, calibracao por modelo |
| ADB instavel com USB hub | Media | Alto | Retry, reconnect, health check rapido, USB hubs powered de qualidade |
| Updates do WhatsApp quebram automacao | Media | Alto | Intent-based (nao depende de coordenadas), versionamento de fluxo |
| Device overheat em uso continuo | Media | Medio | Monitor termal, pausa automatica > 40C |
| WAHA session banida (listener) | Media | Baixo | Nao afeta envio ADB, re-parear automaticamente |
| SQLite write lock sob carga | Baixa | Medio | WAL mode, SKIP LOCKED pattern, read replicas |
| Perda de dados no crash | Baixa | Alto | SQLite WAL + fsync, estado consistente no restart |

---

## Fora de Escopo

1. **Agent Bot AI**: Resposta automatizada via LLM — preparar interfaces mas nao implementar
2. **Screen Mirroring real-time**: scrcpy embed — complexo, pode ser Fase 2
3. **Custom ROM/Spoofing**: Nao eh necessario (ADB fisico ja preserva fingerprints)
4. **Campaign Manager**: Agendamento avancado, A/B testing — plugin futuro
5. **Analytics avancado**: Dashboards BI, exportacao CSV — plugin futuro
6. **iOS support**: Somente Android via ADB
7. **ADB over WiFi/rede**: Somente USB direto no MVP
8. **Multi-instancia Dispatch**: Um app Dispatch por maquina no MVP
9. **Mobile app**: UI mobile nativa — web app responsivo cobre esse caso

---

## Proximos Passos

Apos aprovacao deste PRD:
1. `/prd-to-plan` — criar plano de implementacao por fases (tracer bullets)
2. `/prd-to-issues` — quebrar em issues independentes no GitHub
3. Criar repositorio `amaral-dispatch` no Nx monorepo ou standalone
4. Scaffold Electron + React + TypeScript
5. Implementar ADB Bridge + Message Queue como primeiros modulos (tracer bullet)
6. Testar envio natural no POCO Serenity existente

---

## Notas Adicionais

### Referencia: BipDevice
Ferramenta comercial vietnamita de device farm. Dispatch se diferencia por:
- Foco em WhatsApp + compliance (nao device farm generico)
- Plugin architecture (Oralsin, Vigia, futuro agent bot)
- Chatwoot nativo (inbox bidirecional)
- WAHA como listener passivo (arquitetura hibrida unica)
- Cross-platform (nao so Windows)

### Referencia: Stack Oralsin
O plugin Oralsin reutiliza:
- `BaseNotifier` interface para novo `DispatchNotifier`
- `WhatsappNotificationDTO` como contrato de entrada
- `ContactHistory` outcome tracking
- Registry pattern para channel resolution
- Rate limiting (volume scaling identico ao WAHA client)
- Weekly limit (Redis atomic increment, controlado pela Oralsin)

### Device Atual Catalogado
POCO Serenity (25028PC03G), Android 15, Unisoc T615, 2.7GB RAM, 4 perfis, 8 WhatsApps.
Dados completos em `/var/www/adb_tools/reports/full_study_2026-04-01.md`.
