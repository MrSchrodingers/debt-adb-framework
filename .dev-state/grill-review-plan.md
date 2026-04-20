# Grill Review — Plano de Implementação
## Data: 2026-04-01

## Decisões Tomadas (Entrevista)

### 1. Rede: Infra separada (internet)
Dispatch e Oralsin rodam em servidores distintos, redes diferentes.
**Implicação**: Dispatch precisa de endpoint público para webhooks.

### 2. Endpoint: Reverse proxy + domínio
Dispatch exposto via Nginx/Caddy com domínio próprio (ex: `dispatch.debt.com.br`) + SSL.
**Implicação**: Configuração de `DISPATCH_PUBLIC_URL` no .env. Todos os webhook URLs derivam disso.

### 3. Trust Model: Dispatch confia na Oralsin
Dispatch é executor burro — valida schema (Zod), aplica rate limit anti-ban, despacha.
Toda lógica de negócio (weekly limit, template, paciente ativo) fica na Oralsin.
**Implicação**: Dispatch não precisa de Redis, não duplica regras, contrato simples.

---

## Gaps Técnicos — Resoluções

### 4. SKIP LOCKED → BEGIN IMMEDIATE + CAS (CRÍTICO)
SQLite não tem SKIP LOCKED. Solução:
```sql
-- Dequeue atômico usando BEGIN IMMEDIATE (write lock exclusivo)
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
`BEGIN IMMEDIATE` garante que apenas 1 writer executa por vez (WAL mode permite reads paralelos).
Adicionar coluna `locked_at` para timeout de stale locks.
**Ação**: Atualizar schema no PRD e plan.

### 5. Stale Lock Cleanup
Adicionar cron job (30s interval):
```sql
UPDATE messages
  SET status = 'queued', locked_by = NULL, locked_at = NULL
  WHERE status = 'locked'
    AND locked_at < datetime('now', '-120 seconds');
```
Lock timeout: 120s (tempo máximo para enviar 1 mensagem incluindo typing + screenshot).
**Ação**: Adicionar na Fase 1 como critério de aceitação.

### 6. Phase Dependency Graph — Reconciliação
Versão correta (Plan tem prioridade):
```
Fase 7 depende de: Fase 3 E Fase 5 (ambas)
Fase 8 depende de: Fase 3 E Fase 6 (ambas)
```
**Ação**: Atualizar CLAUDE.md para coincidir com Plan.

### 7. Multi-Profile Queue Design
Queue é GLOBAL (uma única tabela `messages`). Routing é por `sender_number`, não por profile.
Quando o Send Engine dequeue, ele:
1. Resolve qual `whatsapp_account` tem aquele `sender_number`
2. Obtém `device_serial` e `profile_id`
3. Se device está em outro profile, faz `am switch-user N` (lock por device)

Profile_id NÃO está no idempotency_key (mensagem pode ser reenviada por outro profile se o original falhar).
**Ação**: Adicionar `profile_id` na tabela `whatsapp_accounts` (já existe), não na `messages`.

### 8. Rate Limit — Valores Exatos (Port do WAHA Client Oralsin)
```
BASE_MIN_DELAY_S = 20.0
BASE_MAX_DELAY_S = 35.0
VOLUME_WINDOW_MINUTES = 60
VOLUME_SCALE_THRESHOLD = 10    # cada 10 msgs no window
VOLUME_SCALE_FACTOR = 1.5      # multiplica delay por 1.5x
VOLUME_MAX_DELAY_S = 120.0     # cap absoluto
PAIR_RATE_LIMIT_S = 6.0        # mesmo destinatário

Fórmula:
  base_delay = random.uniform(20, 35)
  blocks = volume_in_window // 10
  scale = 1.5 ^ blocks
  scaled_delay = min(base_delay * scale, 120)
```
Idêntico ao `/var/www/oralsim_gestao_inteligente/src/notification_billing/adapters/providers/waha/client.py:282-378`.
**Ação**: Copiar constantes para `dispatch.config.json` com mesmos nomes de env vars.

### 9. OCR Ban Detection — Especificação
- **Região de crop**: Centro da tela (25%-75% width, 30%-70% height)
- **Strings de ban**: `["banned", "suspended", "verify your phone", "verify your number", "unusual activity", "captcha", "confirm your identity"]`
- **Confidence threshold**: >= 60% (Tesseract confidence)
- **Fallback se OCR falha**: Não pausar, logar warning, continuar
- **Processamento**: Async (não bloqueia queue), dedicated worker
- **Latência**: < 5s por screenshot (Tesseract.js com modelo eng pré-carregado)
**Ação**: Adicionar como nota de implementação na Fase 3.

### 10. WAHA Session Pairing — Retry Strategy
- Retry: exponential backoff (5s, 10s, 20s, 40s, 80s) max 5 tentativas
- Se falha 5x: marcar sessão como `pairing_failed`, alertar operador
- Queue NÃO bloqueia esperando pairing (envia sem audit trail, logs warning)
- Re-tentativa automática a cada 5 minutos para sessões `pairing_failed`
**Ação**: Adicionar como critério na Fase 4.

### 11. Chatwoot Operator Reply — Device Offline
Se device original offline quando operador responde:
1. Buscar outro device com MESMO `sender_number` (outro profile)
2. Se nenhum disponível: enfileirar com status `waiting_device`
3. Quando device reconectar: despachar automaticamente
4. TTL de reply: 4 horas (após isso, marcar como `expired` e notificar operador)
**Ação**: Adicionar como critério na Fase 5.

### 12. Callback Delivery Guarantee
- **At-least-once**: Dispatch retenta callback 3x com backoff (5s, 15s, 45s)
- Se 3x falha: persiste em tabela `failed_callbacks` para retry manual
- Callback inclui `idempotency_key` para dedup no lado Oralsin
- **Ação**: Adicionar `idempotency_key` no payload de callback no PRD.

### 13. Contact Registration
- Usar intent `ACTION_INSERT` com `EXTRA_PHONE` e `EXTRA_NAME`
- Nome: primeiro nome do paciente (truncado a 20 chars) ou "Contato" se não fornecido
- Se contato já existe: intent abre editor, script volta com KEYCODE_BACK
- Verificação: screenshot + OCR rápido para confirmar criação
- Se falha: prosseguir com envio via `wa.me` intent (funciona sem contato salvo)
- Funcional em Android 10+ (API level 29+)
**Ação**: Adicionar como nota na Fase 3.

### 14. UI Endpoint Discovery
```typescript
// packages/ui/src/config.ts
const CORE_URL =
  window.__DISPATCH_CORE_URL__  // Electron: injected via preload
  || import.meta.env.VITE_CORE_URL  // Web: env var
  || 'http://localhost:7890'    // Fallback: dev default
```
- Electron: `preload.ts` injeta `window.__DISPATCH_CORE_URL__`
- Web: `.env` com `VITE_CORE_URL=https://dispatch.debt.com.br`
- Docker: env var `CORE_URL` passada no build
**Ação**: Adicionar em CLAUDE.md e Fase 1.

### 15. Device Auth (ADB Pairing)
- Primeira conexão: USB debugging autorizado manualmente no device (prompt na tela)
- Dispatch detecta `unauthorized` via `adb devices` e mostra instrução na UI
- Após autorizar: device salvo automaticamente (RSA key persistida pelo ADB)
- Sem automação de pairing (requer interação física no device, por design do Android)
**Ação**: Adicionar como nota na Fase 1.

### 16. Encryption Key Management
- Chave derivada de machine-id (`/etc/machine-id` Linux, `wmic csproduct get UUID` Windows)
- Chave nunca salva em disco — derivada on-the-fly via PBKDF2
- Se trocar de máquina: re-configurar credenciais (não migra automaticamente)
- `.env` file excluído do backup (já no .gitignore)
**Ação**: Adicionar como nota na Fase 8.

### 17. WAHA Multi-Device Sync Latency
- WhatsApp multi-device sincroniza em 2-10s normalmente
- Acceptance criterion: "Outgoing capturada via WAHA em < 30s" (margem de segurança)
- Se sync falha: logar warning, mensagem registrada apenas pelo ADB send (status `sent_no_audit`)
**Ação**: Atualizar critério na Fase 4.

### 18. Plugin Event Bus Schema
```typescript
interface DispatchEvent {
  type: 'message:queued' | 'message:sent' | 'message:failed' |
        'device:connected' | 'device:disconnected' | 'device:health' |
        'whatsapp:ban' | 'alert:new';
  timestamp: string;          // ISO-8601
  correlationId: string;
  data: Record<string, unknown>;
}
```
- Handlers são async, executam em try/catch isolado
- Erro no handler do plugin NÃO afeta o core (logs error, continua)
- Timeout por handler: 5s (kill se exceder)
**Ação**: Adicionar interface na Fase 7.

---

## Pontos Resolvidos sem Input do Usuário: 15/25

## Pontos que NÃO Bloqueiam Fase 1
Gaps #9, #10, #11, #13, #16, #17, #18 são de fases futuras. Não bloqueiam início.

## Pontos que BLOQUEIAM Fase 1 (devem ser incorporados antes de começar)
- #4 (SKIP LOCKED → BEGIN IMMEDIATE) — schema atualizado
- #5 (Stale lock cleanup) — novo critério
- #14 (UI endpoint discovery) — config pattern
- #15 (Device auth flow) — nota na issue

---

## Próximos Passos

1. Atualizar PRD com decisões tomadas (rede, trust model, callback guarantee)
2. Atualizar Plan com resoluções técnicas (locking, rate limit values, OCR spec)
3. Atualizar Issues #1-8 com gaps resolvidos
4. Iniciar Fase 1 com `/tdd`
