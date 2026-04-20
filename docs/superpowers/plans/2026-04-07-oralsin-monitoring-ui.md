# Oralsin Plugin Monitoring UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Plugins" tab to the Dispatch UI with comprehensive Oralsin monitoring — message lifecycle, callback status, delivery receipts, sender health, and real-time dashboard.

**Architecture:** New "Plugins" tab in sidebar with sub-navigation (Overview, Messages, Senders, Callbacks). Backend adds 4 new API endpoints querying existing tables (messages, failed_callbacks, sender_mapping, pending_correlations). Frontend uses existing patterns (authHeaders, Socket.IO toasts, Recharts, pagination). No new database tables needed.

**Tech Stack:** React 19, Tailwind CSS, Recharts, Socket.IO, Fastify, better-sqlite3, Vitest

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/core/src/api/plugin-oralsin.ts` | 4 REST endpoints: overview, messages, senders, callbacks |
| `packages/core/src/api/plugin-oralsin.test.ts` | Tests for the endpoints |
| `packages/ui/src/components/plugin-tabs.tsx` | Sub-tab navigation within Plugins tab |
| `packages/ui/src/components/oralsin-overview.tsx` | Dashboard: KPI cards, delivery funnel, hourly chart |
| `packages/ui/src/components/oralsin-messages.tsx` | Message lifecycle table with status badges |
| `packages/ui/src/components/oralsin-senders.tsx` | Sender health grid: per-number stats |
| `packages/ui/src/components/oralsin-callbacks.tsx` | Callback audit table with retry |

### Modified Files

| File | Change |
|------|--------|
| `packages/ui/src/App.tsx` | Add 'plugins' tab type, render PluginTabs, Socket.IO delivered/read |
| `packages/ui/src/components/sidebar.tsx` | Add Plugins tab icon |
| `packages/core/src/server.ts` | Register plugin-oralsin routes |
| `packages/core/src/api/index.ts` | Export registerPluginOralsinRoutes |

---

## Task 1: Backend — Plugin Oralsin API Endpoints

**Files:**
- Create: `packages/core/src/api/plugin-oralsin.ts`
- Create: `packages/core/src/api/plugin-oralsin.test.ts`
- Modify: `packages/core/src/api/index.ts`
- Modify: `packages/core/src/server.ts`

- [ ] Write tests for overview, senderStats, callbackLog in `plugin-oralsin.test.ts`
- [ ] Run tests — verify they fail
- [ ] Implement `buildOralsinStats(db)` with 4 methods: overview(), messages(), senderStats(), callbackLog()
- [ ] Implement `registerPluginOralsinRoutes(server, db)` with 4 GET endpoints
- [ ] Export from `api/index.ts`, wire in `server.ts`
- [ ] Run tests — verify all pass
- [ ] Commit: `feat(api): Oralsin plugin monitoring endpoints`

**Endpoints:**
- `GET /api/v1/plugins/oralsin/overview` — KPI stats (today counts, latency, fallback rate, delivery/read counts, hourly breakdown)
- `GET /api/v1/plugins/oralsin/messages?limit=50&offset=0` — Paginated message list with delivery status from pending_correlations
- `GET /api/v1/plugins/oralsin/senders` — Per-sender stats joined with sender_mapping
- `GET /api/v1/plugins/oralsin/callbacks` — Failed callback log

**Key SQL patterns:**
- Filter `WHERE plugin_name = 'oralsin'` on all queries
- JOIN `pending_correlations` on `message_id` for delivered/read status
- JOIN `sender_mapping` for sender metadata
- Use `COUNT(*) FILTER (WHERE ...)` for status breakdowns
- Today filter: `created_at >= strftime('%Y-%m-%dT00:00:00.000Z', 'now')`

---

## Task 2: Sidebar + Tab Routing

**Files:**
- Modify: `packages/ui/src/App.tsx`
- Modify: `packages/ui/src/components/sidebar.tsx`
- Create: `packages/ui/src/components/plugin-tabs.tsx`

- [ ] Add `'plugins'` to Tab type in App.tsx
- [ ] Create `PluginTabs` component with sub-tabs: Overview, Messages, Senders, Callbacks
- [ ] Add Plugins entry (Puzzle icon from lucide-react) to sidebar tabs array
- [ ] Render `<PluginTabs />` when `activeTab === 'plugins'`
- [ ] Commit: `feat(ui): add Plugins tab with Oralsin sub-navigation`

---

## Task 3: Overview Dashboard

**Files:**
- Create: `packages/ui/src/components/oralsin-overview.tsx`

- [ ] Implement KPI cards row: Total, Enviadas, Falhadas, Pendentes, Entregues, Lidas, Latencia, Fallback%, Callbacks
- [ ] Implement hourly BarChart (Recharts) — sent vs failed per hour
- [ ] Implement delivery funnel: sent -> delivered -> read with conversion %
- [ ] Auto-refresh every 10s + Socket.IO refresh on message events
- [ ] Commit: `feat(ui): Oralsin overview dashboard with KPIs and hourly chart`

**Patterns:** Same as `metrics-dashboard.tsx` — `authHeaders()`, `CORE_URL`, `useState/useEffect`, `ResponsiveContainer/BarChart`

---

## Task 4: Message Lifecycle Table

**Files:**
- Create: `packages/ui/src/components/oralsin-messages.tsx`

- [ ] Implement paginated table (50 per page) fetching `/api/v1/plugins/oralsin/messages`
- [ ] Columns: Destino, Texto (truncated), Sender, Status (lifecycle badge), Fallback, Latencia, Criado
- [ ] Status badges: queued(zinc), sending(blue), sent(emerald), delivered(teal+check), read(sky+double-check), failed(red)
- [ ] Expandable rows: full text, context JSON, idempotency_key, correlation_id, waha_message_id, attempts
- [ ] Commit: `feat(ui): Oralsin message lifecycle table with status badges`

---

## Task 5: Sender Health Grid

**Files:**
- Create: `packages/ui/src/components/oralsin-senders.tsx`

- [ ] Implement card grid fetching `/api/v1/plugins/oralsin/senders`
- [ ] Each card: phone, profile ID, WAHA session, active badge, total/sent/failed, error rate, last sent, avg latency, progress bar
- [ ] Commit: `feat(ui): Oralsin sender health grid`

---

## Task 6: Callback Audit Table

**Files:**
- Create: `packages/ui/src/components/oralsin-callbacks.tsx`

- [ ] Implement table fetching `/api/v1/plugins/oralsin/callbacks`
- [ ] Columns: message_id, type (result/ack/response), attempts, lastError, timestamps
- [ ] Retry button per entry (POST to admin retry endpoint)
- [ ] Empty state: green checkmark "Todos callbacks entregues"
- [ ] Commit: `feat(ui): Oralsin callback audit table with retry`

---

## Task 7: Real-Time Socket.IO Events

**Files:**
- Modify: `packages/ui/src/App.tsx`
- Modify: `packages/ui/src/components/oralsin-overview.tsx`

- [ ] Add `message:delivered` and `message:read` Socket.IO listeners in App.tsx with toasts
- [ ] In oralsin-overview, add Socket.IO auto-refresh on sent/failed/delivered/read events
- [ ] Commit: `feat(ui): real-time Socket.IO for Oralsin plugin events`

---

## Task 8: Integration Test

- [ ] Run `npm test` — all tests pass
- [ ] Manual verification: open Plugins tab in Electron, verify all 4 sub-tabs render with data
- [ ] Final commit: `feat(ui): complete Oralsin monitoring UI`
