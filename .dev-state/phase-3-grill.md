# Phase 3 Grill — Send Engine Robusto + Anti-Ban

> Data: 2026-04-02
> Status: ✅ COMPLETO (18 decisões)

## Decisões

### 1. Central Dispatcher (signal-driven Temporal workflow)
- Dispatcher é um Temporal Workflow contínuo que reage a Signals
- Signals: `message:enqueued`, `device:connected`, `ban:expired`
- Timers internos do Temporal pra cooldowns
- Zero polling, zero CPU idle
- Calcula próximo envio, despacha SendMessageWorkflow como child

### 2. Dynamic Tick via Temporal
- Dispatcher usa `Temporal.sleep(nextAvailableTime)` entre dispatches
- Recalcula ao receber qualquer Signal
- Sem setInterval fixo

### 3. Per-Number Rate Limits, Per-Device Serial Execution
- Rate limiting (volume scaling, pair limit) tracked per WA number
- Cada device processa 1 mensagem por vez (serial)
- Device pode ter múltiplos números (profiles), cada um com rate limit independente

### 4. Active Rebalancing (Distribution)
- Quando múltiplos números têm cooldown expirado, dispatcher escolhe o com menor send count no volume window
- Garante max 10% desvio de distribuição
- Scoring: timing first (cooldown expirado?), tiebreak by fewer sends

### 5. Ban Detection: Post-Send OCR + Periodic Probe
- Após cada envio: OCR no screenshot de prova (async, não bloqueia)
- A cada 5 minutos: probe dedicado abre WA, screenshot home screen, OCR
- OCR é sinal, não veredito — precisa de validação

### 6. Ban Validation: Behavioral
- OCR flagra suspeita → abre chat via `wa.me/{number}` intent
- UIAutomator checa se campo de input do chat existe
- Sem input field = ban confirmado
- Mais confiável que OCR — testa funcionalidade real

### 7. Ban Duration: UIAutomator Countdown Extraction
- Ban confirmado → navega em Configurações do WhatsApp
- UIAutomator dump extrai texto do countdown decrescente
- WhatsApp mostra "Você poderá usar o WhatsApp novamente em X horas e Y minutos"
- Parseia duração → calcula `ban_expires_at = now + duração`

### 8. Ban Pause/Unpause Strategy
- Pause exato baseado no countdown extraído + 5min buffer
- No horário do unpause → behavioral probe automático
- Se liberou → resume sending
- Se ainda banido → re-extrai countdown (pode ter renovado)
- Se countdown sumiu mas WA não funciona → escalona pra manual (alerta operador)
- Persiste em `whatsapp_accounts.ban_status` + `ban_expires_at`

### 9. Retry: 5 Attempts, Same Number, Exponential Backoff
- Max 5 tentativas por mensagem
- Sempre no mesmo `senderNumber` (trocar número é decisão do caller)
- Backoff: 30s, 60s, 120s, 240s, 480s
- Após 5 falhas → `permanently_failed` + alerta
- Se número banido → mensagem fica `waiting_device` até ban expirar

### 10. Auto-Recovery: Crash Detection + Force-Stop Cycle
- Detecção: UIAutomator não acha botão send (já no fluxo, zero overhead)
- Confirmação: `adb shell pidof com.whatsapp`
- Sem PID → `am force-stop com.whatsapp` + `am start` com intent do chat → retry
- Com PID mas sem UI → `input keyevent BACK` ×3 + re-open intent → retry
- Falha após recovery → `attempts++`, volta pra fila

### 11. Jitter: Em Cima do Rate Limiter
- Rate limiter calcula `scaled_delay` (20s-120s via volume scaling)
- Jitter multiplica por fator aleatório (distribuição exponencial 0.8-1.5)
- `final_delay = clamp(scaled_delay × jitter_factor, 20s, 300s)`
- Floor 20s (anti-ban mínimo), cap 300s (throughput)

### 12. Contact Registration: Background Pre-Registration
- Quando mensagem entra na fila, dispatcher agenda registro no device alvo
- Activity `registerContact` roda em background antes do envio
- No momento do envio, contato já existe no device
- Fallback: se registration falhou, `wa.me` intent funciona sem contato salvo

### 13. Send Phase Locking: Granular Per-Device
- `Map<deviceSerial, SendPhase>` persistido no Redis
- SendPhase: `idle | registering_contact | opening_chat | typing | sending | screenshotting | recovering`
- Device actions (reboot, restart-wa) bloqueadas se `sendPhase !== 'idle'`
- UI consome send phase em real-time via Socket.IO
- Device desconecta durante envio → mensagem volta pra fila, phase reseta

### 14. Temporal Everywhere (Electron + Server)
- **Electron**: Temporal CLI embedded (SQLite persistence) como child process do main process
- **Server/Headless**: Temporal Server full (PostgreSQL) via Docker
- **Workers**: Rodam no processo Node.js do core (mesmo código)
- Interface idêntica em ambos os modos — Temporal SDK abstrai o backend

### 15. Redis: Hot State Efêmero
- Rate limit timestamps (TTL automático)
- Volume window counters (expire 60min)
- Send phase per device (atualização frequente)
- Pair rate limit / last send per recipient (TTL 6s)
- Device cooldown timers
- **Electron**: Redis embarcado (KeyDB/redis-server minimal) ou sidecar
- **Server**: Redis dedicado via Docker

### 16. Workflow Design
```
SendMessageWorkflow(messageId, senderNumber, toNumber, body)
  ├── Activity: resolveDevice(senderNumber) → deviceSerial, profileId
  ├── Activity: acquireSendLock(deviceSerial) → lockId
  ├── Activity: ensureContact(deviceSerial, toNumber, contactName)
  ├── Activity: openWhatsAppChat(deviceSerial, toNumber)
  ├── Activity: typeMessage(deviceSerial, body)
  ├── Activity: tapSendButton(deviceSerial) → screenshot
  ├── Activity: validateSend(screenshot) → {ok, suspect_ban}
  │     ├── if suspect_ban → ChildWorkflow: BanDetectionWorkflow
  │     └── if ok → continue
  ├── Activity: releaseSendLock(deviceSerial, lockId)
  └── Activity: updateMessageStatus(messageId, 'sent', screenshot)

BanDetectionWorkflow(deviceSerial, senderNumber)
  ├── Activity: behavioralProbe(deviceSerial, senderNumber) → banned?
  ├── Activity: navigateToWaSettings(deviceSerial)
  ├── Activity: extractBanCountdown(deviceSerial) → duration
  ├── Activity: pauseNumber(senderNumber, ban_expires_at)
  └── Signal: ban:expired (scheduled at ban_expires_at + 5min)

BanProbeWorkflow(senderNumber) — scheduled every 5min for banned numbers
  ├── Activity: behavioralProbe → still banned?
  ├── if cleared → Activity: resumeNumber + Signal dispatcher
  └── if still banned → re-extract countdown, reschedule

HealthCheckWorkflow(deviceSerial) — scheduled every 30s
  ├── Activity: collectHealth(deviceSerial) → metrics
  ├── Activity: persistHealth(metrics) → SQLite
  └── Activity: evaluateAlerts(metrics) → emit alerts if threshold breached

DispatcherWorkflow — continuous, signal-driven
  ├── on Signal message:enqueued → recalculate next dispatch
  ├── on Signal device:connected → add device to pool
  ├── on Signal ban:expired → resume number
  ├── on Timer (next cooldown expiry) → dispatch SendMessageWorkflow
  └── State: cooldowns per number, send counts, device pool
```

### 17. All-Senders-Banned: Callback Degradação
- Dispatcher detecta todos os números banidos
- Emite evento `system:degraded`
- Envia callback pro caller (Oralsin) com status `all_senders_banned`
- Fila continua aceitando mensagens (201)
- Caller decide fallback (WAHA API, SMS, etc.)
- Quando qualquer número libera → `system:recovered`, callback pro caller

### 18. Observabilidade

**Métricas real-time (Redis → Socket.IO → UI):**
- Messages in queue por status (queued, sending, sent, failed)
- Send rate (msgs/min por número)
- Average delay atual vs base
- Volume scaling factor por número
- Send phase por device
- Ban status por número

**Métricas históricas (SQLite → API → UI):**
- Success rate (sent/total) por hora/dia
- Latência média (enqueue → sent) por número
- Retry rate (attempts > 1 / total)
- Ban frequency por número
- Distribution fairness (% msgs por número)

**Alertas automáticos:**
- Success rate < 80% em janela de 1h
- Latência média > 5min
- Número banido (immediate)
- Fila crescendo sem sends > 10min
- All senders banned (critical)

---

## Constantes de Configuração (dispatch.config.json)

```json
{
  "rateLimit": {
    "baseMinDelayS": 20.0,
    "baseMaxDelayS": 35.0,
    "volumeWindowMinutes": 60,
    "volumeScaleThreshold": 10,
    "volumeScaleFactor": 1.5,
    "volumeMaxDelayS": 120.0,
    "pairRateLimitS": 6.0,
    "jitterMin": 0.8,
    "jitterMax": 1.5,
    "finalDelayFloorS": 20.0,
    "finalDelayCapS": 300.0
  },
  "retry": {
    "maxAttempts": 5,
    "backoffBaseS": 30,
    "backoffMultiplier": 2.0
  },
  "banDetection": {
    "ocrConfidenceThreshold": 0.6,
    "banStrings": ["banned", "suspended", "verify your phone", "verify your number", "unusual activity", "captcha", "confirm your identity", "banido", "suspenso", "verificar seu telefone", "atividade incomum"],
    "probeIntervalMinutes": 5,
    "unpauseBufferMinutes": 5
  },
  "autoRecovery": {
    "forceStopTimeoutS": 5,
    "backPressCount": 3,
    "restartWaitS": 3
  },
  "alerts": {
    "successRateThreshold": 0.8,
    "successRateWindowMinutes": 60,
    "latencyThresholdMinutes": 5,
    "staleQueueMinutes": 10
  }
}
```

## Impacto Arquitetural

### Novas dependências (packages/core)
- `@temporalio/client` + `@temporalio/worker` + `@temporalio/workflow` + `@temporalio/activity`
- `ioredis` (Redis client)
- `tesseract.js` (OCR)

### Novas dependências (packages/electron)
- Temporal CLI binary (embedded server)
- Redis/KeyDB binary (embedded)

### Mudanças em módulos existentes
- `send-engine.ts` → refatorado em Temporal Activities
- `server.ts` → worker loop removido, substituído por Temporal Worker
- `queue/message-queue.ts` → enqueue emite Signal pro Dispatcher
- `monitor/device-manager.ts` → device:connected emite Signal

### Novos módulos
- `packages/core/src/temporal/` — workflows, activities, worker setup
- `packages/core/src/redis/` — Redis client, rate limit store
- `packages/core/src/engine/rate-limiter.ts` — volume scaling algorithm
- `packages/core/src/engine/ban-detector.ts` — OCR + behavioral validation
- `packages/core/src/engine/dispatcher.ts` — distribution logic (consumed by DispatcherWorkflow)
