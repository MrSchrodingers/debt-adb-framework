# SQLite Schema Reference — Dispatch ADB Framework

> Auto-generated: 2026-04-06 | DB: better-sqlite3, WAL mode
> All tables created via `initialize()` methods (no migration files)

## Tables (10 total)

### messages
**File**: `packages/core/src/queue/message-queue.ts`
**Purpose**: Message queue — core FIFO with priority, locking, plugin support

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | TEXT PK | nanoid() | Queue message ID |
| to_number | TEXT NOT NULL | | Recipient phone |
| body | TEXT NOT NULL | | Message content |
| idempotency_key | TEXT UNIQUE NOT NULL | | Dedup key |
| priority | INTEGER NOT NULL | 5 | Lower = higher priority (1=high, 5=normal) |
| sender_number | TEXT | NULL | Which phone sends |
| status | TEXT NOT NULL | 'queued' | queued→locked→sending→sent/failed/permanently_failed |
| attempts | INTEGER NOT NULL | 0 | Send attempt counter |
| locked_by | TEXT | NULL | Device serial holding lock |
| locked_at | TEXT | NULL | Lock timestamp |
| plugin_name | TEXT | NULL | Which plugin created (null=manual) |
| correlation_id | TEXT | NULL | For tracing across systems |
| senders_config | TEXT | NULL | JSON array of sender configs |
| context | TEXT | NULL | Opaque JSON pass-through for callbacks |
| waha_message_id | TEXT | NULL | Linked WAHA message ID (set by dedup) |
| max_retries | INTEGER NOT NULL | 3 | Per-message retry limit |
| created_at | TEXT NOT NULL | now() | |
| updated_at | TEXT NOT NULL | now() | |

**Indexes**: `idx_messages_dequeue(status, priority, created_at)`

**Status machine**: `queued → locked → sending → sent | failed | permanently_failed`

**Dequeue pattern** (atomic):
```sql
BEGIN IMMEDIATE;
UPDATE messages SET status='locked', locked_by=?, locked_at=now()
WHERE id = (SELECT id FROM messages WHERE status='queued'
            ORDER BY priority ASC, created_at ASC LIMIT 1)
RETURNING *;
COMMIT;
```

---

### contacts
**File**: `packages/core/src/queue/message-queue.ts`

| Column | Type | Default |
|--------|------|---------|
| phone | TEXT PK | |
| name | TEXT NOT NULL | |
| registered_at | TEXT NOT NULL | now() |

---

### devices
**File**: `packages/core/src/monitor/device-manager.ts`

| Column | Type | Default |
|--------|------|---------|
| serial | TEXT PK | |
| brand | TEXT | NULL |
| model | TEXT | NULL |
| status | TEXT NOT NULL | 'offline' |
| last_seen_at | TEXT NOT NULL | now() |
| alert_thresholds | TEXT | NULL (JSON) |

---

### health_snapshots
**File**: `packages/core/src/monitor/health-collector.ts`

| Column | Type | Default |
|--------|------|---------|
| id | INTEGER PK AUTO | |
| serial | TEXT NOT NULL | |
| battery_percent | INTEGER NOT NULL | |
| temperature_celsius | REAL NOT NULL | |
| ram_available_mb | INTEGER NOT NULL | |
| storage_free_bytes | INTEGER NOT NULL | |
| wifi_connected | INTEGER NOT NULL | 0 |
| collected_at | TEXT NOT NULL | now() |

**Index**: `idx_health_serial_time(serial, collected_at)`
**Retention**: 7 days (cleaned hourly)

---

### whatsapp_accounts
**File**: `packages/core/src/monitor/wa-account-mapper.ts`

| Column | Type | Default |
|--------|------|---------|
| device_serial | TEXT NOT NULL | |
| profile_id | INTEGER NOT NULL | |
| package_name | TEXT NOT NULL | |
| phone_number | TEXT | NULL |
| updated_at | TEXT NOT NULL | now() |

**PK**: `(device_serial, profile_id, package_name)`
**Phone extraction**: `content query` on Android contacts provider

---

### alerts
**File**: `packages/core/src/monitor/alert-system.ts`

| Column | Type | Default |
|--------|------|---------|
| id | TEXT PK | nanoid() |
| device_serial | TEXT NOT NULL | |
| severity | TEXT NOT NULL | critical/high/medium/low |
| type | TEXT NOT NULL | 8 types |
| message | TEXT NOT NULL | |
| resolved | INTEGER NOT NULL | 0 |
| resolved_at | TEXT | NULL |
| created_at | TEXT NOT NULL | now() |

**Index**: `idx_alerts_device(device_serial, resolved)`

---

### message_history
**File**: `packages/core/src/waha/message-history.ts`

| Column | Type | Default |
|--------|------|---------|
| id | TEXT PK | nanoid() |
| message_id | TEXT | NULL (links to messages.id) |
| direction | TEXT NOT NULL | incoming/outgoing |
| from_number | TEXT | |
| to_number | TEXT | |
| text | TEXT | |
| media_type | TEXT | NULL |
| media_path | TEXT | NULL |
| device_serial | TEXT | NULL |
| profile_id | INTEGER | NULL |
| waha_message_id | TEXT | NULL |
| waha_session_name | TEXT | NULL |
| captured_via | TEXT NOT NULL | adb_send/waha_webhook/chatwoot_reply |
| created_at | TEXT NOT NULL | now() |

**Indexes**: `idx_history_numbers`, `idx_history_waha_message_id`, `idx_history_dedup`
**Retention**: 90 days

**Dedup**: `findByDedup(to_number, timestamp, ±30s)` matches `adb_send` records for WAHA correlation

---

### managed_sessions
**File**: `packages/core/src/chatwoot/managed-sessions.ts`

| Column | Type | Default |
|--------|------|---------|
| session_name | TEXT PK | |
| phone_number | TEXT NOT NULL | |
| device_serial | TEXT | NULL |
| profile_id | INTEGER | NULL |
| chatwoot_inbox_id | INTEGER | NULL |
| managed | INTEGER NOT NULL | 1 |
| created_at | TEXT NOT NULL | now() |

---

### plugins
**File**: `packages/core/src/plugins/plugin-registry.ts`

| Column | Type | Default |
|--------|------|---------|
| name | TEXT PK | |
| version | TEXT NOT NULL | |
| webhook_url | TEXT NOT NULL | |
| api_key | TEXT NOT NULL | |
| hmac_secret | TEXT NOT NULL | |
| events | TEXT NOT NULL | '[]' (JSON) |
| enabled | INTEGER NOT NULL | 1 |
| status | TEXT NOT NULL | 'active' |
| created_at | TEXT NOT NULL | now() |
| updated_at | TEXT NOT NULL | now() |

---

### failed_callbacks
**File**: `packages/core/src/plugins/plugin-registry.ts`

| Column | Type | Default |
|--------|------|---------|
| id | TEXT PK | nanoid() |
| plugin_name | TEXT NOT NULL | |
| message_id | TEXT NOT NULL | |
| callback_type | TEXT NOT NULL | result/ack/response |
| payload | TEXT NOT NULL | JSON |
| webhook_url | TEXT NOT NULL | |
| attempts | INTEGER NOT NULL | 0 |
| last_error | TEXT NOT NULL | '' |
| created_at | TEXT NOT NULL | now() |
| last_attempt_at | TEXT NOT NULL | now() |

**Index**: `idx_failed_callbacks_plugin(plugin_name)`

## Common Patterns

- **Timestamps**: `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` (ISO 8601 UTC)
- **IDs**: `nanoid()` (21 chars default)
- **JSON fields**: stored as TEXT, parsed in application layer
- **WAL mode**: `db.pragma('journal_mode = WAL')` set on every connection
- **Transactions**: `db.transaction(() => { ... }).immediate()` for atomic dequeue
