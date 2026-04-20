# Phase 5 Grill — Session Management + Inbox Automation

## Date: 2026-04-02
## Status: COMPLETE (12 decisions)

## Scope Redefinition

**Original**: "Chatwoot Bridge Bidirecional" — build incoming/outgoing bridges, operator reply routing
**Revised**: "Session Management + Inbox Automation" — WAHA native handles the bridge

### Why the change

1. WAHA Plus already has native Chatwoot App integration — all 8 oralsin_* sessions
   already connected to Chatwoot inboxes (1:1 mapping)
2. Incoming messages: WAHA → Chatwoot App nativo (zero Dispatch intervention)
3. Outgoing messages: ADB sends → WhatsApp multi-device sync → WAHA captures → Chatwoot
   App displays (existing Phase 4 dedup handles message_history)
4. Operator replies: continue via WAHA native (Chatwoot → WAHA API → WhatsApp Web)

Dispatch does NOT need to call Chatwoot API for messages. The native integration covers it.

---

## Decisions

### 1. Chatwoot Infrastructure
- **Instance**: self-hosted at `chat.debt.com.br`, same server as WAHA (`37.27.210.137`)
- **Version**: v4.11.0 (Build 2bd1d88)
- **Account ID**: 1
- **Already operational**: operators and agents actively using it
- **Implication**: local communication between WAHA and Chatwoot (no network latency)

### 2. No Explicit Message Bridge Needed
- **Incoming**: 100% WAHA nativo → Chatwoot App. Dispatch does NOT create incoming messages.
- **Outgoing (ADB)**: ADB → WhatsApp multi-device sync → WAHA captures → Chatwoot App displays.
  Phase 4 dedup (±30s) already records in message_history.
- **Operator reply**: WAHA native path. Dispatch does NOT intercept.
- **Implication**: no Chatwoot message API calls needed. Drastically simplified scope.

### 3. Inbox Automation (Admin UI)
- **Flow**: Admin in Electron UI creates WAHA session + Chatwoot inbox in one step
- **Steps**: 
  1. Create inbox in Chatwoot (POST /api/v1/accounts/1/inboxes, type: "api")
  2. Configure Chatwoot App on WAHA session (PUT /api/sessions/{name}/chatwoot)
  3. Result: session and inbox connected
- **Inbox naming**: auto-generated default pattern, editable by user
- **Implication**: single endpoint orchestrates both APIs

### 4. Session Selector (Multi-Select "Managed")
- **Purpose**: admin selects which WAHA sessions participate in ADB dispatch
- **UI**: list all WAHA sessions → multi-select → mark as "managed"
- **Managed=true**: Dispatch monitors health, routes ADB messages via this session
- **Managed=false**: Dispatch ignores completely, WAHA+Chatwoot native continues
- **Implication**: only admin-approved sessions enter the dispatch pipeline

### 5. Managed Sessions Persistence (Separate Table)
- **Decision**: new `managed_sessions` table, NOT extending `whatsapp_accounts`
- **Rationale**: `whatsapp_accounts` is auto-discovered every 5min by WaAccountMapper.
  Mixing manual (managed flag, chatwoot_inbox_id) with auto-discovered data causes
  race conditions and potential data loss.
- **Schema**:
  ```sql
  CREATE TABLE managed_sessions (
    session_name TEXT PRIMARY KEY,
    phone_number TEXT NOT NULL,
    device_serial TEXT,
    profile_id INTEGER,
    chatwoot_inbox_id INTEGER,
    managed INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
  );
  ```
- **Join**: `managed_sessions.phone_number = whatsapp_accounts.phone_number`

### 6. QR Code Flow
- **Source**: WAHA API returns QR as base64 image
- **Display**: Electron UI shows QR inline
- **Status updates**: webhook `session.status` → Socket.IO → UI reacts in real-time
- **Regenerate**: button in UI calls WAHA API to restart session → new QR
- **No polling**: pure event-driven via existing Phase 4 WebhookHandler

### 7. Credentials Model
```env
CHATWOOT_API_URL=https://chat.debt.com.br
CHATWOOT_ACCOUNT_ID=1
CHATWOOT_API_TOKEN=<env var, never hardcoded>
WAHA_API_URL=<already configured>
WAHA_API_KEY=<same key for all sessions>
```
- Chatwoot Account Token is agent/admin level
- Single WAHA API key for all sessions

### 8. WAHA↔Chatwoot Integration Type
- **Via**: Chatwoot App nativo do WAHA Plus (not generic webhook)
- **Config per session**: `{ chatwoot: { account_id, api_url, token } }`
- **Implication**: Dispatch configures this via WAHA API, not Chatwoot API

### 9. Session Naming Convention
- **Existing pattern**: `oralsin_{device}_{user}` (e.g., oralsin_1_2 = device 1, user 2)
- **Device 1**: POCO Serenity (ADB), users 1-4
- **Device 2**: second device, users 1-3
- **Main sessions**: oralsin_main_1, oralsin_main_2
- **Total**: 8 oralsin_* sessions, each with 1:1 Chatwoot inbox
- **Future**: user will follow similar pattern for new ADB sessions

### 10. Managed Flag Behavior
- **Permanent**: managed=true persists until admin manually unmarks
- **No auto-unmark**: session WAHA failing or device offline does NOT clear the flag
- **Routing respects real state**: DeviceManager (online/offline) + SessionManager (WORKING/FAILED)
  already gate actual message routing. Managed flag only means "eligible to participate."
- **Rationale**: auto-unmark would require manual re-mark after recovery — unnecessary friction.
  Alerts inform degradation. Recovery is automatic (Phase 4 backoff).

### 11. Chatwoot HTTP Client
- **Purpose**: wrapper for Chatwoot REST API
- **Scope**: create inbox, list inboxes (minimal for Phase 5)
- **Auth**: `api_access_token` header
- **Base URL**: `${CHATWOOT_API_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}`

### 12. Admin UI in Electron
- **Section**: "Session Manager" in Electron app
- **Features**:
  - List WAHA sessions (name, status, phone, has Chatwoot?)
  - Multi-select managed sessions
  - "Configure Chatwoot" button for sessions without Chatwoot App
  - "Pair" button → shows QR code from WAHA API
  - Status real-time via Socket.IO

---

## Session Map (Current)

| Session | Phone | Device | User | Status | Chatwoot |
|---------|-------|--------|------|--------|----------|
| oralsin_1_2 | 554396835102 | 1 (POCO) | 2 | WORKING | inbox 175 |
| oralsin_1_3 | 554396837887 | 1 (POCO) | 3 | WORKING | yes |
| oralsin_1_4 | 554396837945 | 1 (POCO) | 4 | WORKING | yes |
| oralsin_2_1 | 554396835095 | 2 | 1 | WORKING | yes |
| oralsin_2_2 | 554396837813 | 2 | 2 | WORKING | yes |
| oralsin_2_3 | 554396837844 | 2 | 3 | WORKING | yes |
| oralsin_main_1 | 554396835104 | main | 1 | WORKING | yes |
| oralsin_main_2 | 554396835100 | main | 2 | WORKING | yes |

---

## Impact on Original PRD Criteria

| Original Criterion | Status | Reason |
|-------------------|--------|--------|
| Inbox criada automaticamente por número | KEPT (manual trigger) | Admin UI automates creation |
| Incoming aparece no Chatwoot em <10s | ALREADY COVERED | WAHA native Chatwoot App |
| Outgoing aparece no Chatwoot em <30s | ALREADY COVERED | Multi-device sync + WAHA capture |
| Operador responde → ADB envia | NOT NEEDED | WAHA native handles replies |
| Conversa completa visível | ALREADY COVERED | WAHA native both directions |
| Device offline re-route | SIMPLIFIED | Managed flag + DeviceManager routing |
