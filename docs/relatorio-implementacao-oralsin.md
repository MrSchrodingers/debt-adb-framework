# Relatorio Tecnico de Implementacao — Dispatch ADB Framework
## Integracao Oralsin: Hardening & Enriquecimento de Auditoria

> **Data**: 2026-04-08
> **Versao**: 2.0 (pos-hardening)
> **Autor**: Matheus Munhoz + Claude Opus 4.6
> **Status**: Pronto para testes bilaterais

---

## 1. Contexto

O Dispatch ADB Framework envia mensagens WhatsApp via automacao ADB em dispositivos Android fisicos. A integracao com o Oralsin (sistema de cobranca de clinicas odontologicas) foi validada no Phase 7 do desenvolvimento — o plugin Oralsin enfileira mensagens, o Dispatch envia via ADB, e callbacks HMAC-assinados reportam o resultado.

Apos o primeiro teste bilateral, **6 bugs criticos** foram identificados que bloqueavam uso em producao. Este relatorio documenta todas as correcoes, melhorias, e o estado atual do sistema.

---

## 2. Resumo Executivo

| Metrica | Valor |
|---------|-------|
| Bugs corrigidos | 6 criticos + 5 de E2E |
| Campos de auditoria adicionados | 7 novos no callback `delivery` |
| Testes automatizados | 462 passando (42 arquivos) |
| Commits nesta iteracao | 6 |
| Arquivos modificados | 18 |
| Linhas adicionadas | 1.184 |
| Validacao E2E | 4/4 senders, 4/4 profiles, 4/4 screenshots |
| Code reviews realizados | 2 (pos-implementacao + pos-enriquecimento) |
| Issues CRITICAL encontrados | 0 (apos correcoes) |

---

## 3. Bugs Corrigidos

### 3.1 User Switch por Mensagem (CRITICAL)

**Problema**: `am switch-user` era chamado DENTRO de `send()` para cada mensagem individual. O switch leva 3-5s, reseta o foreground, e podia cortar mensagens no meio da digitacao.

**Correcao**: User switch movido para o worker loop no nivel de batch. O worker resolve o `profileId` via `senderMapping`, chama `switchToUser()` uma unica vez, e depois processa todas as mensagens do batch sem trocar usuario.

```
ANTES: dequeue → send() → switch-user → open wa.me → type → switch-user → open → type ...
DEPOIS: dequeue → switch-user (1x) → poll confirmation → send() → send() → send() ...
```

O switch agora usa **poll-based confirmation**: apos `am switch-user N`, o worker verifica `am get-current-user` a cada 1s por ate 10s. Se o usuario nao muda, o batch inteiro eh requeue'd.

### 3.2 Dialogs do WhatsApp Bloqueiam Envio (CRITICAL)

**Problema**: Apos abrir `wa.me/{phone}`, o WhatsApp pode mostrar popups ("Enviar para", "Continuar no WhatsApp", "Permitir") que impedem a digitacao. O SendEngine ia direto para typing sem verificar.

**Correcao**: Novo metodo `waitForChatReady()` com ate 5 tentativas:
1. Dump UIAutomator XML
2. Verificar se ha dialogs conhecidos → `dismissDialogs()` toca no botao correto
3. Verificar se `com.whatsapp:id/entry` (campo de texto) esta presente
4. Se nao, aguardar 1s e tentar novamente

Dialogs tratados:
- "Enviar para" / "Abrir com" → toca "WhatsApp" + "Sempre"
- "Continuar" / "Continue" → toca o botao
- "Permitir" / "Allow" → toca o botao

### 3.3 Nomes com Espaco/Acento Truncados (IMPORTANT)

**Problema**: `content insert --bind data1:s:"Matheus Amaral Parra Munhoz"` — aspas duplas no shell ADB fazem o nome ser truncado ou perder acentos.

**Correcao**: Novo modulo `contact-utils.ts` com `escapeForAdbContent()` que usa single-quote wrapping com escape de aspas internas:

```
"João da Silva"      → 'João da Silva'
"O'Brien"            → 'O'"'"'Brien'
"Matheus A. P. M."   → 'Matheus A. P. M.'
```

### 3.4 Tela Desligada/Trancada Causa Falha (IMPORTANT)

**Problema**: O SendEngine tentava enviar com a tela desligada ou lockscreen ativa, causando falha silenciosa.

**Correcao**: `ensureScreenReady()` executa proativamente antes de cada envio:
1. `KEYCODE_WAKEUP` — acorda a tela
2. `dumpsys window` — verifica lockscreen
3. Se trancado → `input swipe 540 1800 540 800` (swipe up)

### 3.5 Callback com Poucas Tentativas (IMPORTANT)

**Problema**: Apenas 3 retries com backoff curto `[0s, 5s, 15s]`. Sem retry automatico apos as 3 tentativas.

**Correcao**:
- **4 tentativas** com backoff `[0s, 5s, 30s, 120s]`
- **Worker periodico** (60s) retenta callbacks falhados ate 10 vezes
- `/healthz` inclui `failed_callbacks` count para monitoramento

### 3.6 Screenshot Nao Persistido (IMPORTANT)

**Problema**: Screenshots eram tomados apos envio mas ficavam apenas em memoria. Nenhum registro visual do envio.

**Correcao**:
- Screenshot salvo em `reports/sends/{messageId}.png`
- Coluna `screenshot_path` adicionada na tabela `messages`
- API endpoint: `GET /api/v1/messages/:id/screenshot` serve o PNG
- UI mostra thumbnail no expanded row de cada mensagem

---

## 4. Bugs Encontrados e Corrigidos no E2E

Durante a validacao E2E com o POCO C71, 5 problemas adicionais foram descobertos e corrigidos:

| Bug | Causa Raiz | Correcao |
|-----|-----------|----------|
| `mScreenOn` nao existe no POCO C71 | Android 15 usa `mWakefulness=Awake` ao inves de `mScreenOn=true` | Regex aceita ambos os formatos |
| `--user N` no `am start` nao abre o WhatsApp | Android 15 trata o flag de forma diferente, retorna "Activity not started" | Flag removido — user switch ja feito pelo worker |
| `am force-stop --user N` nao para o WhatsApp | O flag `--user` eh silenciosamente ignorado no force-stop | Usa `am force-stop com.whatsapp` sem flag |
| UIAutomator retorna "null root node" | Apos user switch, o UIAutomator precisa de tempo para re-indexar a UI | `dumpUi()` faz retry ate 3x com 1s de espera |
| WhatsApp "Activity not started, brought to front" | WhatsApp ja estava aberto em background de envio anterior | `ensureCleanState()` agora faz `force-stop` antes de cada envio |

---

## 5. Campos de Auditoria Enriquecidos

O callback `result` (`status=sent`) agora inclui **7 novos campos** no objeto `delivery`:

| Campo | Tipo | Exemplo | Descricao |
|-------|------|---------|-----------|
| `device_serial` | string | `"9b01005930533036340030832250ac"` | Serial do device Android que enviou |
| `profile_id` | number | `10` | ID do profile Android (0, 10, 11, 12) |
| `char_count` | number | `142` | Caracteres digitados via ADB |
| `contact_registered` | boolean | `true` | Se um contato NOVO foi criado no Android |
| `screenshot_url` | string\|null | `"/api/v1/messages/abc/screenshot"` | URL relativa para screenshot pos-envio |
| `dialogs_dismissed` | number | `1` | Quantos dialogs do WhatsApp foram fechados |
| `user_switched` | boolean | `true` | Se o worker trocou de usuario Android |

### Payload completo de exemplo (status=sent):

```json
{
  "idempotency_key": "oralsin-sched-abc123",
  "correlation_id": "pipeline-run-1",
  "status": "sent",
  "sent_at": "2026-04-08T13:33:00.000Z",
  "delivery": {
    "message_id": null,
    "provider": "adb",
    "sender_phone": "+5543996835100",
    "sender_session": "oralsin_2_main",
    "pair_used": "POCO-user0",
    "used_fallback": false,
    "elapsed_ms": 25739,
    "device_serial": "9b01005930533036340030832250ac",
    "profile_id": 0,
    "char_count": 142,
    "contact_registered": true,
    "screenshot_url": "/api/v1/messages/ASX3cZuc76EPre2fhBlIm/screenshot",
    "dialogs_dismissed": 0,
    "user_switched": false
  },
  "error": null,
  "context": {
    "clinic_id": "uuid-1",
    "schedule_id": "uuid-2",
    "mode": "overdue"
  }
}
```

---

## 6. Split Pre-Due / Overdue

### Abordagem

O Oralsin controla o roteamento pre_due/overdue no lado Django. O Dispatch **nao precisa de nenhuma mudanca** para suportar isso.

### Como funciona

1. **Enqueue**: O Oralsin envia `context: { "mode": "overdue" }` no payload de enqueue
2. **Processamento**: O Dispatch processa normalmente via ADB
3. **Callback**: O Dispatch devolve `context` intacto — o Oralsin sabe que era overdue

### Recomendacao de implementacao (lado Oralsin)

```python
class CoveredClinic(models.Model):
    dispatch_mode = models.CharField(
        max_length=20,
        choices=[
            ("disabled", "Desabilitado"),
            ("overdue_only", "Apenas inadimplentes"),
            ("all", "Todos os fluxos"),
        ],
        default="disabled",
    )
```

```python
def _should_use_dispatch(clinic_id: str, mode: str) -> bool:
    clinic = CoveredClinic.objects.get(pk=clinic_id)
    if clinic.dispatch_mode == "disabled":
        return False
    if clinic.dispatch_mode == "overdue_only":
        return mode == "overdue"
    return True  # "all"
```

---

## 7. Fluxo Completo: Ponta a Ponta

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        FLUXO ORALSIN → DISPATCH → WAHA                     │
│                                                                             │
│  Oralsin Django                    Dispatch ADB                    WAHA     │
│  ─────────────                     ────────────                    ────     │
│                                                                             │
│  1. NotificationSendWorkflow       ┌─────────────────────┐                 │
│     mode=overdue                   │  POST /enqueue       │                 │
│     ───────────────────────────►   │  Zod validation      │                 │
│     {idempotency_key, patient,     │  Sender resolution   │                 │
│      message, senders[],           │  Batch insert DB     │                 │
│      context: {mode:"overdue"}}    │  ← 201 {id, status}  │                 │
│                                    └─────────┬───────────┘                 │
│                                              │                              │
│                                    ┌─────────▼───────────┐                 │
│                                    │  Worker Loop (5s)    │                 │
│                                    │  dequeueBySender()   │                 │
│                                    │  switchToUser(N)     │                 │
│                                    │  poll get-current    │                 │
│                                    └─────────┬───────────┘                 │
│                                              │                              │
│                                    ┌─────────▼───────────┐                 │
│                                    │  SendEngine.send()   │                 │
│                                    │  1. ensureScreenReady│                 │
│                                    │  2. force-stop WA    │                 │
│                                    │  3. ensureContact    │                 │
│                                    │  4. am start wa.me   │                 │
│                                    │  5. waitForChatReady │                 │
│                                    │  6. type char-by-char│                 │
│                                    │  7. tapSendButton    │                 │
│                                    │  8. screenshot       │                 │
│                                    │  9. save to disk     │                 │
│                                    └─────────┬───────────┘                 │
│                                              │                              │
│  ┌─────────────────────┐         ┌───────────▼─────────┐                   │
│  │  Webhook callback   │◄────────│  CallbackDelivery   │                   │
│  │  HMAC SHA-256       │         │  4 retries           │                   │
│  │  {status, delivery, │         │  [0,5s,30s,120s]    │                   │
│  │   context}          │         │  + worker 60s (10x)  │                   │
│  └─────────────────────┘         └─────────────────────┘                   │
│                                                                             │
│                                              │ (async, via WAHA listener)   │
│                                              ▼                              │
│  ┌─────────────────────┐         ┌─────────────────────┐   ┌────────────┐ │
│  │  ACK callback       │◄────────│  ReceiptTracker     │◄──│ WAHA ACK   │ │
│  │  {level:2, delivered│         │  correlacao por      │   │ webhook    │ │
│  │   level:3, read}    │         │  to+sender+30s      │   └────────────┘ │
│  └─────────────────────┘         └─────────────────────┘                   │
│                                                                             │
│  ┌─────────────────────┐         ┌─────────────────────┐   ┌────────────┐ │
│  │  Response callback  │◄────────│  MessageHistory     │◄──│ WAHA msg   │ │
│  │  {body, from_number}│         │  query incoming      │   │ received   │ │
│  └─────────────────────┘         └─────────────────────┘   └────────────┘ │
│                                                                             │
│  Fallback (se ADB falha):                                                  │
│  SendEngine throws → processMessage catches → wahaFallback.send()          │
│  → WAHA API envia → callback com provider="waha", used_fallback=true       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Configuracao de Senders

4 WhatsApp accounts registrados no POCO C71 (Android 15, root):

| Sender | Profile | Sessao WAHA | Par Oralsin | Status |
|--------|---------|-------------|-------------|--------|
| +5543996835100 | 0 (main) | oralsin_2_main | POCO-user0 | Ativo |
| +5543996835095 | 10 | oralsin_2_1 | POCO-user10 | Ativo |
| +5543996837813 | 11 | oralsin_2_2 | POCO-user11 | Ativo |
| +5543996837844 | 12 | oralsin_2_3 | POCO-user12 | Ativo |

O Oralsin envia `senders[]` ordenado por prioridade. O Dispatch tenta o primeiro que tem sender_mapping configurado.

---

## 9. Retry e Resiliencia

### Retry de Envio

| Cenario | Comportamento |
|---------|---------------|
| ADB falha (dialog, timeout, tela) | Tenta WAHA fallback automaticamente |
| ADB + WAHA falham | `permanently_failed`, callback com `error.retryable` |
| Device desconectado | Worker pula ciclo, tenta no proximo |
| User switch falha (10s timeout) | Batch inteiro requeue'd |
| UIAutomator "null root node" | Retry automatico (3x) |

### Retry de Callback

| Fase | Tentativas | Backoff |
|------|-----------|---------|
| Inline (sincrono) | 4 | `[0s, 5s, 30s, 120s]` |
| Worker periodico | +6 (ate 10 total) | A cada 60s |
| Persistencia | `failed_callbacks` table | Auditavel via API |

---

## 10. Monitoramento

### Endpoints disponiveis

| Endpoint | Retorno |
|----------|---------|
| `GET /healthz` | Status, devices online, queue pending, failed_callbacks |
| `GET /api/v1/monitoring/oralsin/overview` | KPIs do dia (total, sent, failed, delivered, read, latencia) |
| `GET /api/v1/monitoring/oralsin/messages?status=&limit=&offset=` | Mensagens paginadas com filtro |
| `GET /api/v1/monitoring/oralsin/senders` | Stats por sender |
| `GET /api/v1/monitoring/oralsin/callbacks` | Log de callbacks falhados |
| `GET /api/v1/messages/:id/screenshot` | Screenshot PNG do envio |
| `GET /api/v1/plugins/oralsin/status` | Status do plugin |
| `GET /api/v1/plugins/oralsin/queue` | Fila (pending, processing, failed) |

Todos requerem header `X-API-Key`.

### Dashboard UI

A UI React inclui tab "Plugins" com:
- **Overview**: KPIs em tempo real, grafico horario sent/failed (Recharts)
- **Mensagens**: Tabela paginada com filtro por status, expanded row com contexto + screenshot
- **Senders**: Grid de saude por sender (total, sent, failed, latencia, ultimo envio)
- **Callbacks**: Auditoria de callbacks falhados com retry count e ultimo erro

---

## 11. Seguranca

| Controle | Implementacao |
|----------|---------------|
| API Auth | `X-API-Key` header obrigatorio em todas as rotas |
| HMAC Callbacks | SHA-256 com secret por plugin |
| Shell Injection | Validacao `/^\d{10,15}$/` em phone numbers antes de interpolacao shell |
| Path Traversal | Screenshot API valida `resolve(path).startsWith(SCREENSHOTS_DIR)` |
| Profile ID | Validacao `Number.isInteger && >= 0` antes de `am switch-user` |
| Contact Escaping | Single-quote wrapping com escape de aspas internas |

---

## 12. Nota sobre `delivery.message_id`

O campo `message_id` sera **`null`** no callback `result` quando `provider=adb`. Isso ocorre porque a automacao ADB nao tem como obter o ID interno da mensagem do WhatsApp.

**Isso NAO eh blocker** porque:
1. O Oralsin usa `idempotency_key` como chave de correlacao, nao `message_id`
2. O callback ACK (delivered/read) usa o `message_id` do Dispatch, que o Oralsin ja tem
3. Se o WAHA capturar a mensagem outgoing (via correlacao `to_number + sender_number + ±30s`), o `message_id` WAHA sera linkado automaticamente

Quando `provider=waha` (fallback), o `message_id` contem o ID WAHA real.

---

## 13. Implementacao Lado Oralsin (Concluida)

O lado Oralsin ja implementou o split pre_due/overdue:

### Backend (`oralsim_gestao_inteligente`)

| Componente | Descricao |
|-----------|-----------|
| **Model** | `CoveredClinic.dispatch_mode` com choices `disabled` / `overdue_only` / `all` |
| **API** | `PATCH /api/coverage-clinics/<uuid>/dispatch-mode/` — SUDO only, valida choices |
| **Serializer** | `dispatch_mode` adicionado ao `CoveredClinicSerializer` |
| **Routing** | `_should_use_dispatch(clinic_id, mode)` — mode-aware, split pre_due/overdue |
| **Migration** | `0054_dispatch_mode_choices` |

### Frontend (`oralsim_gestao_inteligente_frontend`)

| Componente | Descricao |
|-----------|-----------|
| **Service** | `dispatch.service.ts` — `listClinics()`, `setDispatchMode()` |
| **Hook** | `useDispatch.ts` — `useDispatchClinics()`, `useSetDispatchMode()` |
| **UI** | Nova tab "Dispatch ADB" na pagina `/admin/notificacoes` |
| **Acesso** | Apenas SUDO (`mrschrodingers` + `admin@oralsin`) — endpoint retorna 403 para outros |

### Funcionalidades da tab "Dispatch ADB"

- Lista de todas as clinicas ativas
- Select dropdown por clinica (`disabled` / `overdue_only` / `all`)
- Toast feedback no sucesso/erro
- Badge com contagem de clinicas ativas no tab

---

## 14. Proximos Passos

### Imediato

1. **Configurar `"overdue_only"`** para Bauru via admin
2. **Agendar teste bilateral** com volume baixo (5-10 msgs overdue)
3. **Monitorar callbacks** no `/healthz` e dashboard UI

### Dispatch

1. ~~Hardening T1-T6~~ DONE
2. ~~E2E 4-sender validation~~ DONE (GATE passed)
3. ~~Enriched audit fields~~ DONE
4. Proximo: Multi-device support (Phase 8 hardening)
5. Proximo: Docker container para deploy

---

## 15. Evidencias do E2E

### Teste final: 4 senders, 4 profiles

```
=== E2E v5 4-Sender Results ===
  sender=+5543996835095  status=sent  screenshot=YES
  sender=+5543996835100  status=sent  screenshot=YES
  sender=+5543996837813  status=sent  screenshot=YES
  sender=+5543996837844  status=sent  screenshot=YES
Sent: 4/4, Screenshots: 4/4
```

Screenshots salvos em `reports/sends/` com tamanhos entre 291KB-308KB (PNG, resolucao nativa do POCO C71).

### Code Review Final

| Severidade | Encontrados | Corrigidos |
|------------|-------------|------------|
| CRITICAL | 0 | — |
| IMPORTANT | 5 | 3 corrigidos, 2 pre-existentes aceitos |
| MINOR | 6 | 1 corrigido |

---

## 16. Referencia Rapida: Spec do Webhook

Documento completo: **`docs/oralsin-webhook-spec.md`**

Contem:
- Payloads de todos os 4 tipos de callback (result, ack, response)
- Tabela de referencia de todos os campos `delivery`
- Formato do enqueue request
- Politica de retry
- Endpoints de monitoramento
- Codigos de erro
