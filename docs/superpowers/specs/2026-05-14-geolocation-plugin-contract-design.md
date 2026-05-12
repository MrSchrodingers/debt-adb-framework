# Design — Geolocalização (plugin-first contract)

> **Status**: aprovado em brainstorming 2026-05-14. Próximo passo: plano via `writing-plans`.
> **Constraint vinculante**: feature é PLUGIN-FIRST. Core funciona sem nenhum plugin com geo view. Princípio espelha o sistema de plugins atual (Phase 7 + NEW-5 Sprint 2).
> **Escopo da sessão**: 4 views (1 Oralsin + 3 adb-precheck). Aba "global" deferida pra plugin separado.

## 1. Resumo

Aba "Geolocalização" mostra mapa do Brasil com choropleth por DDD. Cada plugin contribui suas próprias views via `ctx.registerGeoView(...)`. Core hospeda apenas o framework (mapa + topology + endpoints genéricos de delegation + UI de tabs dinâmicas).

**Decisões já tomadas (brainstorming)**:
- Granularidade: **DDDs (~66)** — não estados, não municípios.
- Lib de mapa: **deck.gl + GeoJsonLayer** (choropleth puro, base map null, zero token comercial).
- Color scale: **d3-scale-chromatic** (Viridis/RdYlGn/PuOr conforme palette hint).
- Aba "global" cross-plugin: **deferida** — implementável depois como plugin novo sem mudar contract.

## 2. Princípio de isolamento

**Core não importa nada de plugins.** Tudo passa pelo registry.

```
GeoPage (UI)
   ↓ GET /api/v1/geo/views
Core { GeoViewRegistry, BrazilMapDDD, topology }
   ↑ ctx.registerGeoView(...)
Plugins { oralsin, adb-precheck, ... }
```

Garantias:
1. Plugin desabilitado → view some do registry → tab some da UI.
2. Plugin com erro em `aggregate()` → endpoint retorna 503 só pra aquela view; outras seguem.
3. Adicionar plugin novo com geo view = zero código no core/UI.
4. `/api/v1/geo/views` com zero plugins ativos retorna `{views:[]}` — UI mostra empty state.

## 3. Contrato `GeoViewDefinition`

Novo arquivo: `packages/core/src/geo/types.ts`.

```ts
export interface GeoViewDefinition {
  id: string                      // 'oralsin.sends' — DEVE começar com plugin.name + '.'
  label: string                   // 'Envios'
  description?: string
  group: string                   // auto-fill com plugin.name
  palette: 'sequential' | 'diverging' | 'rate'
  filters: GeoFilterSpec[]
  aggregate(params: GeoQueryParams): Promise<GeoAggregation>
  drill(ddd: string, params: GeoQueryParams): Promise<GeoDrillResult>
}

export type GeoFilterSpec =
  | { type: 'window'; id: string; defaultValue: '24h'|'7d'|'30d'; options: Array<'24h'|'7d'|'30d'|'all'> }
  | { type: 'select'; id: string; label: string; defaultValue: string; options: Array<{ value: string; label: string }> }

export interface GeoQueryParams {
  window: '24h' | '7d' | '30d' | 'all'
  filters: Record<string, string>
  page?: number       // drill only, default 1
  pageSize?: number   // drill only, default 50, cap 200
}

export interface GeoAggregation {
  buckets: Record<string, number>     // { '11': 4823, '21': 1207, ... }
  total: number                       // === sum(buckets)
  generatedAt: string                 // ISO
}

export interface GeoDrillResult {
  columns: Array<{ key: string; label: string; type?: 'date'|'number'|'string'|'phone' }>
  rows: Array<Record<string, unknown>>
  total: number
  page: number
  pageSize: number
}
```

Extensão de `PluginContext`:

```ts
export interface PluginContext {
  // ... existing
  registerGeoView(view: GeoViewDefinition): void
}
```

**Runtime guarantees** no loader:
- `view.id` MUST start with `plugin.name + '.'` → erro fatal se conflito.
- destroy() do plugin esvazia views dele do registry.
- aggregate/drill timeout 5s (igual PluginEventBus).
- Erros do plugin: capturados → 503, não derruba o core.

## 4. API REST (3 endpoints genéricos)

Auth: `X-API-Key` (igual `/api/v1/admin/*`).

### 4.1 `GET /api/v1/geo/views`

```json
{
  "views": [
    {
      "id": "oralsin.sends",
      "label": "Envios",
      "description": "Heatmap de envios efetivados por DDD",
      "group": "oralsin",
      "palette": "sequential",
      "filters": [
        { "type": "window", "id": "window", "defaultValue": "7d", "options": ["24h","7d","30d"] },
        { "type": "select", "id": "status", "label": "Status",
          "defaultValue": "sent",
          "options": [{"value":"sent","label":"Enviadas"}, ...] }
      ],
      "pluginName": "oralsin",
      "pluginStatus": "active"
    }
  ],
  "groups": [
    { "name": "oralsin", "label": "Oralsin", "viewIds": ["oralsin.sends"] },
    { "name": "adb-precheck", "label": "ADB-Precheck", "viewIds": ["adb-precheck.no-match", ...] }
  ],
  "generatedAt": "2026-05-14T12:34:56.789Z"
}
```

### 4.2 `GET /api/v1/geo/views/:viewId/aggregate?window=7d&...`

- Resolve view do registry → **404** se inexistente.
- Valida `filters` contra `GeoFilterSpec[]` via Zod → **400** em inválido.
- `view.aggregate({window, filters})` com timeout 5s → **503** em erro/timeout do plugin.
- Retorna `GeoAggregation`.
- ETag = hash do payload; `If-None-Match` → 304.

### 4.3 `GET /api/v1/geo/views/:viewId/drill?ddd=11&window=7d&page=1`

- Mesma validação + `ddd` regex `^\d{2}$` + ∈ lista BR válida → 400.
- `view.drill(ddd, params)` timeout 8s → 503 em erro.
- Retorna `GeoDrillResult` com colunas plugin-defined.

### 4.4 Error contract

```json
// 404
{ "error": "view_not_found", "viewId": "oralsin.foo" }
// 400
{ "error": "invalid_filter", "field": "status", "reason": "value not in options" }
// 503
{ "error": "plugin_aggregate_failed", "viewId": "oralsin.sends",
  "pluginError": "...", "retryable": true }
```

## 5. Frontend

### 5.1 Estrutura

```
packages/ui/src/components/geo/
├── geo-page.tsx           # root: query /geo/views, renderiza tabs por group
├── geo-tabs.tsx           # groups (top tabs) + views (sub-tabs)
├── geo-view-panel.tsx     # FilterBar + Map + Legend por view
├── brazil-map-ddd.tsx     # deck.gl GeoJsonLayer + tooltip + click
├── filter-bar.tsx         # render declarativo dos filters
├── legend.tsx             # color scale + aria-label
├── drill-modal.tsx        # tabela paginated genérica
├── empty-state.tsx        # "nenhum plugin com visão geográfica ativa"
├── fallback-table.tsx     # toggle "ver como tabela" pra a11y/no-webgl
└── geo.types.ts           # espelha core types

packages/ui/public/topology/
└── br-ddds.json           # TopoJSON 66 DDDs BR (T2 audit acha source)
```

### 5.2 Render principal (`brazil-map-ddd.tsx`)

```tsx
import { DeckGL } from '@deck.gl/react'
import { GeoJsonLayer } from '@deck.gl/layers'
import { interpolateViridis } from 'd3-scale-chromatic'

// Props: { topology, buckets, palette, onDddClick, max }
// Render: <DeckGL/> com base map=null, GeoJsonLayer com getFillColor(f) =
//   rgbFromHex(palette(buckets[f.properties.ddd] / max))
// Tooltip via getTooltip → { ddd, label do DDD, count }
// Click → onDddClick(ddd) abre DrillModal
```

### 5.3 Tabs dinâmicas

- `<GeoTabs/>` lê `/geo/views` response.
- Se 0 groups → `<EmptyState/>`.
- Se 1 group → mostra só sub-tabs (sem top tabs).
- Se ≥2 groups → top tabs (group label) + sub-tabs (view label).
- Active tab persiste em URL params (`?view=oralsin.sends&window=7d&status=sent`).

### 5.4 Sidebar

- `Tab` type em `App.tsx` ganha `'geo'`.
- Item novo na `Sidebar` com ícone `Map` (lucide-react).
- Atalho de teclado: `g l` (seguindo padrão `gd`/`gm`/`ga`).

### 5.5 A11y

- Legend tem `aria-label="Escala de cores de 0 a {max}"`.
- Cada feature do GeoJsonLayer tem aria-label via deck.gl `getAriaLabel`.
- `<FallbackTable/>` toggle ("Ver como tabela") renderiza `{ddd, label, count}` ordenado desc.
- Status nunca só cor — sempre acompanhado de número.

### 5.6 Dependências novas

```json
{
  "dependencies": {
    "@deck.gl/core": "^9.x",
    "@deck.gl/layers": "^9.x",
    "@deck.gl/react": "^9.x",
    "d3-scale-chromatic": "^3.x",
    "topojson-client": "^3.x"   // converter TopoJSON → GeoJSON em runtime
  }
}
```

Bundle estimado: +200KB gzip. Lazy-load via `React.lazy(() => import('./components/geo/geo-page'))` pra não impactar primeiro paint de outras tabs.

## 6. Dados

### 6.1 DDD extractor

`packages/core/src/util/ddd.ts`:

```ts
export function extractDdd(phone: string): string | null {
  const digits = phone.replace(/\D/g, '')
  const stripped = digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits
  if (stripped.length < 10) return null
  const ddd = stripped.slice(0, 2)
  return VALID_BR_DDDS.has(ddd) ? ddd : null
}
```

Testes: 13 dígitos com 55, 11 dígitos sem, 12 dígitos com 55 (fixo antigo), inválido (DDD 20), phone muito curto, phone com `+` e espaço.

### 6.2 Sources (REQUER PHASE_2 AUDIT antes do TDD)

| View | Tabela candidata | Filtro | Confirmação |
|---|---|---|---|
| `oralsin.sends` | `messages` (queue) | `plugin_name='oralsin' AND status=$status AND created_at>=...` | audit confirma plugin_name column |
| `adb-precheck.no-match` | `hygiene_job_items` (Phase 9.2) | `status='not_exists' AND processed_at>=...` | audit confirma colunas |
| `adb-precheck.valid` | `wa_contact_checks` (Phase 9.1) | `result='valid' AND checked_at>=...` | audit confirma colunas |
| `adb-precheck.pipedrive-mapped` | `pipedrive_activities`/`pipedrive_*` | requer audit | T5 audit |

### 6.3 Índices

Adicionar em migration nova:

```sql
CREATE INDEX IF NOT EXISTS idx_messages_ddd_created
  ON messages(substr(to_number, 3, 2), created_at);
CREATE INDEX IF NOT EXISTS idx_hygiene_items_ddd_processed
  ON hygiene_job_items(substr(phone_normalized, 3, 2), processed_at);
CREATE INDEX IF NOT EXISTS idx_wa_checks_ddd_checked
  ON wa_contact_checks(substr(phone_normalized, 3, 2), checked_at);
```

Performance budget: aggregate < 500ms p99 com 90 dias de dado. Medir após index; se passar, denormalizar coluna `ddd` em follow-up.

### 6.4 Cache

- **In-memory LRU** no `GeoViewRegistry` por `(viewId, paramsHash)` TTL 60s.
- **ETag** = sha256(payload) → `If-None-Match` → 304.
- Invalidação manual via `registry.invalidate(viewId)` — plugins chamam best-effort em writes (não obrigatório).

## 7. Estrutura de arquivos a criar/modificar

### Backend (core)

```
packages/core/src/
├── geo/
│   ├── types.ts                    # NEW — interfaces
│   ├── registry.ts                 # NEW — GeoViewRegistry (LRU cache + invalidate)
│   ├── registry.test.ts            # NEW — TDD
│   ├── filter-validator.ts         # NEW — Zod validation contra GeoFilterSpec
│   └── filter-validator.test.ts    # NEW
├── util/
│   ├── ddd.ts                      # NEW — extractDdd + VALID_BR_DDDS
│   └── ddd.test.ts                 # NEW
├── api/
│   └── geo.ts                      # NEW — 3 routes
│   └── geo.test.ts                 # NEW (integration)
├── plugins/
│   ├── types.ts                    # MOD — adiciona registerGeoView
│   ├── plugin-loader.ts            # MOD — wire registerGeoView no PluginContext
│   ├── plugin-loader.test.ts       # MOD — testes registerGeoView
│   ├── oralsin-plugin.ts           # MOD — init registra 1 view
│   ├── oralsin-plugin.test.ts      # MOD — testa view aggregate/drill
│   └── adb-precheck-plugin.ts      # MOD — registra 3 views
└── server.ts                       # MOD — instancia GeoViewRegistry, wire routes
```

### Migrations

```
packages/core/migrations/
└── XXX_geo_indexes.sql             # NEW — 3 índices DDD
```

### Frontend (ui)

```
packages/ui/src/
├── components/geo/
│   ├── geo-page.tsx                # NEW
│   ├── geo-tabs.tsx                # NEW
│   ├── geo-view-panel.tsx          # NEW
│   ├── brazil-map-ddd.tsx          # NEW
│   ├── brazil-map-ddd.test.tsx     # NEW (RTL render)
│   ├── filter-bar.tsx              # NEW
│   ├── filter-bar.test.tsx         # NEW
│   ├── legend.tsx                  # NEW
│   ├── drill-modal.tsx             # NEW
│   ├── empty-state.tsx             # NEW
│   ├── fallback-table.tsx          # NEW
│   └── geo.types.ts                # NEW
├── components/sidebar.tsx          # MOD — adiciona "geo" item
└── App.tsx                         # MOD — Tab type + lazy import
```

### Public assets

```
packages/ui/public/topology/
└── br-ddds.json                    # NEW — TopoJSON BR DDDs (source TBD: T2 audit)
```

## 8. Testing strategy

- **Unit (Vitest)**: ddd.ts, geo/registry.ts, geo/filter-validator.ts, oralsin view aggregate/drill, 3 adb-precheck views.
- **Integration**: api/geo.ts com mock plugin + Fastify inject.
- **RTL**: brazil-map-ddd (smoke render com mock topology + buckets), filter-bar (render filtros declarativos), drill-modal (paginação).
- Min coverage: 5 testes backend por view + 3 testes UI por componente.
- E2E manual: smoke endpoint via curl em prod (Kali); screenshot em `reports/2026-05-14-geolocation-tab.png`.

## 9. Phases (alinhar com CLAUDE.md pipeline)

1. **PHASE_2_AUDIT** (Explore agent) — schemas + DDD extractor pré-existente? + Pipeboard source.
2. **PHASE_3_PLAN** (writing-plans skill) — tracer bullets verticais.
3. **PHASE_4_BACKEND_TDD** — DDD util → registry → filter-validator → routes → Oralsin view → adb-precheck views.
4. **PHASE_5_FRONTEND_TDD** — types → BrazilMap → FilterBar → GeoTabs → GeoPage → Sidebar wire → App.tsx.
5. **PHASE_6_DEPLOY** — build + push + ssh dispatch deploy + smoke + screenshot.
6. **PHASE_7_GATE** — 9 quality gates + progress.md.

## 10. Quality gates (definição final)

- [ ] **Plugin isolation**: core sem plugins → /geo/views retorna `{views:[]}`, UI mostra empty state.
- [ ] **Plugin isolation 2**: plugin Oralsin desabilitado → suas views somem da UI (verificar via admin/plugins toggle).
- [ ] **Cobertura**: 4 views renderizam mapa + filtros + legenda.
- [ ] **Filtros**: window + status/outcome funcionam (refresh on change).
- [ ] **Drill**: click em DDD abre modal paginado.
- [ ] **Endpoints**: 3 endpoints HTTP 200 via curl com auth.
- [ ] **Backend tests**: ≥5 testes pra registry + ≥3 por view (aggregate + drill + edge case).
- [ ] **UI build**: tsc + vite build clean, zero console errors.
- [ ] **A11y**: legend tem aria-label, fallback table renderiza.
- [ ] **Deploy**: HEAD local = origin/main = Kali; services active; smoke OK.
- [ ] **Screenshot**: salvo em `reports/2026-05-14-geolocation-tab.png`.

## 11. Riscos e mitigações

| Risco | Probabilidade | Mitigação |
|---|---|---|
| TopoJSON BR-DDDs não existir public/licensed | Média | T2 audit; fallback é montar manual via shapefile IBGE municípios + Anatel DDD lookup (custa horas). |
| deck.gl bundle empurra UI bundle inicial | Baixa | Lazy-load via React.lazy → bundle só baixa quando user abre aba. |
| Pipedrive-mapped view requer query lenta | Média | Index expressional + LRU cache; se ainda >500ms, denormaliza ddd column em follow-up. |
| Plugin registra view com id duplicado | Baixa | Loader rejeita no register; throw fatal no init → plugin status='error'. |
| Tablet/mobile: deck.gl WebGL perf ruim | Baixa | FallbackTable toggle resolve; desktop é o caso primário. |

## 12. Não-objetivos desta sessão

- Aba "global" cross-plugin → follow-up.
- Geolocalização por município (~5570) → não cabe.
- Real-time push (Socket.IO) → polling on filter change basta; push depois.
- Geolocalização por device físico (sender real lat/long) → fora de escopo.
- Mapa-múndi (DDIs internacionais) → fora de escopo.

---

**Status do design**: aprovado nas 5 seções do brainstorming (2026-05-14). Próximo passo: invocar `writing-plans` para produzir plano executável.
