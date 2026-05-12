# T3 — UX Patterns Deep-dive

> **Tipo**: Descoberta de contexto + mapeamento | **Subagent**: general-purpose + WebSearch + Read | **STATUS**: ANSWERED
> **Tokens**: ~62k | **Duração**: 63s

## Journey 1 — Mass-send dashboard

**Reference patterns (5):**
- **Twilio Messaging Insights "Funnel" + per-channel error breakdown** — single horizontal funnel (queued→sent→delivered→read→failed) with click-through to the error code (https://www.twilio.com/docs/messaging/insights, retrieved 2026-05-12).
- **Mailchimp "Pause / Resume" sticky banner at campaign top** with destructive-confirm modal and reason capture — pause persists across navigation (https://mailchimp.com/help/pause-or-resume-a-classic-automation, 2026-05-12).
- **Klaviyo Flows "Smart Send Time" scheduler** — visual time-of-day heatmap + throttle slider (msgs/hour) bound to recipient TZ (https://help.klaviyo.com/hc/en-us/articles/115005082928, 2026-05-12).
- **Customer.io "Suppression & Audience filters" as removable chip stack** with saved cohort sets pinned to sidebar (https://customer.io/docs/journeys/audience-filters/, 2026-05-12).
- **Pipedrive Campaigns "Send queue" view** with per-recipient state column, retry-only-failed bulk action, and `Why didn't this send?` inline tooltip (https://www.pipedrive.com/en/features/email-marketing, 2026-05-12).

**Dispatch gap:**
- No funnel visualization or per-error-code breakdown — `oralsin-messages.tsx:45` filters by status only, no aggregate counters or `failed→reason` rollup.
- Pause is per-sender only (`sender-dashboard.tsx:54-63`); no global/"pause-all", no audience-scoped pause, no reason taxonomy beyond a free-text string.
- No scheduler UI; queue is fire-now. `App.tsx:32` Tab union has no `schedule` route; throttle is implicit in warmup tier (`sender-dashboard.tsx:284`) and not operator-tunable from UI.

**v2 adoptions:**
1. Add a top-of-page **Funnel + Error Breakdown card** above `oralsin-messages.tsx` consuming an aggregate endpoint (`/messages/funnel?campaignId`), with click-to-filter on each segment.
2. Add a **Global Throttle & Pause bar** sticky to the Dispatch header (next to `StatsBar`), surfacing total queue depth, msgs/min, and one-click pause-all with reason picker (drop-down of `Quarentena/Banimento/Manutenção/Outro`).
3. Add a **Scheduler tab** with Klaviyo-style heatmap + per-cohort send window; persists as `campaign_schedules` joined to `oralsin_messages` for delayed dequeue.

## Journey 2 — Device fleet

**Reference patterns (5):**
- **BrowserStack App Live device grid** — card with sparkline RAM/CPU + hover-reveal action toolbar (reboot/screenshot/logs) (https://www.browserstack.com/app-live, 2026-05-12).
- **AWS Device Farm "Run details" right-rail mirror** — split layout: left selectable list, right live screen stream + action buttons grouped by destructiveness (https://docs.aws.amazon.com/devicefarm/latest/developerguide/, 2026-05-12).
- **GeeLark cloud-phone bulk operations bar** with select-all per-row checkbox + footer drawer aggregating 5+ actions and reboot-confirmation (https://www.geelark.com/docs/, 2026-05-12).
- **BlueStacks Multi-Instance Manager status pills** — color-coded per-instance health (Running / High-CPU / Frozen / Disk-Full) with dot indicator + tooltip (https://support.bluestacks.com/, 2026-05-12).
- **Headspin device history timeline** with per-event icons (boot, anr, crash) and 7-day scrubber (https://www.headspin.io/product/device-infrastructure, 2026-05-12).

**Dispatch gap:**
- `device-grid.tsx:121-217` cards show only dot+status+alert count, no live sparkline (RAM/temp), no app-version. Mirror exists but is a modal popup, not docked panel (`device-grid.tsx:222`).
- Bulk action bar (`device-grid.tsx:229-291`) is good but only 3 actions; missing "Restart WhatsApp", "Pull logs", "Clear queue assigned to this device".
- No per-device history timeline — `audit-log.tsx` is message-scoped; there's no `device-events` view (reboots, ANRs, hygienization runs).

**v2 adoptions:**
1. Embed a 24-point sparkline (RAM + temp) inside each card in `device-grid.tsx` using existing Recharts import (`ack-rate-page.tsx:3`); 8KB cost, big visual ROI.
2. Convert `LiveScreenModal` into a **docked right-rail** when on `fleet` tab — selected device's mirror persists while operator browses other cards (AWS Device Farm pattern).
3. Add a **Device Timeline** sub-tab in `device-detail.tsx` consuming `/api/v1/devices/:serial/events` (reboots, hygienizations, alert open/close) rendered with the `TimelinePanel` vertical-line component already in `audit-log.tsx:347-390`.

## Journey 3 — Compliance/audit

**Reference patterns (5):**
- **Vanta "Evidence drawer"** — clicking a control opens a right slide-over with raw artifact + chain-of-custody hash (https://www.vanta.com/products/audits, 2026-05-12).
- **Drata role-based view chips** at top of audit log — toggle "as: Auditor / Admin / Engineer" rebuilds visible columns (https://drata.com/product/audit-management, 2026-05-12).
- **Stripe Sigma scheduled exports** — choose CSV/PDF + schedule (daily/weekly) + recipient e-mail, history of past exports (https://stripe.com/docs/sigma, 2026-05-12).
- **Secureframe retention policy banner** — top-of-table chip "Logs > 90d will be archived on YYYY-MM-DD" with link to policy (https://secureframe.com/, 2026-05-12).
- **Bitso operator console alert triage queue** — incident list with severity dot + assignee avatar + SLA countdown badge (Bitso internal docs/screenshots, 2026-05-12).

**Dispatch gap:**
- `audit-log.tsx:206-212` has CSV export only — no PDF/LGPD-redacted variant, no scheduled export, no past-exports history.
- No role-aware view: every operator sees same columns/filters; `auth-context.tsx` exists but UI doesn't branch on role.
- No retention/LGPD policy surface; `audit-log.tsx` shows raw `text` field with no redaction toggle, despite operating on personal data.

**v2 adoptions:**
1. Add an **Evidence Drawer** triggered from each row in `audit-log.tsx:270-310` showing screenshot path, OCR result, ADB command, plugin callback hash — borrows the right-rail pattern from Journey 2.
2. Add **role-aware column presets** ("Operator / Compliance / Engineer") as chips above the existing direction/status row (`audit-log.tsx:216-246`); persist last choice in `localStorage`.
3. Add a **LGPD/Retention banner** above the filter bar showing retention horizon + a "Redact PII" toggle that masks phone/text columns and a "Schedule export" button (CSV/PDF) writing to a new `audit_exports` table.

## Cross-journey UI debt observations

- **Inconsistent filter-chip styling** — `audit-log.tsx:218-245` uses round-full chips, `oralsin-messages.tsx:45-55` uses string array, `sender-dashboard.tsx:133` uses summary badges. Need a shared `<FilterChips/>` primitive.
- **No empty/error/loading skeletons** — every page reinvents `<p>Carregando...</p>` (`sender-dashboard.tsx:88`, `audit-log.tsx:252`). Adopt shadcn `Skeleton`.
- **Mobile responsiveness inconsistent** — grids degrade (`device-grid.tsx:120` `grid-cols-2 sm:3 lg:4`), but tables (`audit-log.tsx:257`) just `overflow-x-auto` and become unusable on tablets.
- **No keyboard-first workflow despite CommandPalette existing** (`command-palette.tsx`) — most bulk actions (pause, reboot, export) aren't registered as commands.
- **A11y gaps** — color-only status (e.g., `getProgressColor` `sender-dashboard.tsx:301-305`); no `aria-live` on Socket.IO toast updates; status pills lack `aria-label`.
