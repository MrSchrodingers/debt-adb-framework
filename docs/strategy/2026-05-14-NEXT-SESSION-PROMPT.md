# Next-Session Prompt — Geolocalização: mapa do BR com heatmaps + pontos por DDD, separado por plugin

> **Identidade da sessão**: você é o orquestrador de uma sessão de **design + spec + research + implementação** de uma feature de visualização geográfica para o Dispatch. Repo em `/var/www/adb_tools`. Esta sessão deve produzir, ao final, uma tab nova "Geolocalização" rodando em produção no Kali (`dispatch.tail106aa2.ts.net`), commitada e versionada em `origin/main`.

## Contexto carregado (leia ANTES de qualquer outra coisa)

Em uma única mensagem com múltiplos `Read` tool_uses:

1. `docs/strategy/2026-05-14-feature-geolocation.md` — **spec base capturada na sessão anterior** (contém decisões em aberto + estimativas + bloqueadores)
2. `docs/strategy/2026-05-13-feature-roadmap-v2.md` — roadmap v2 vigente (não inclui esta feature; decidir como encaixar)
3. `CLAUDE.md` — protocolo obrigatório do projeto (GRILL → TDD → IMPLEMENT → REVIEW → PHASE GATE)
4. `.dev-state/progress.md` — estado atual
5. `packages/core/src/plugins/adb-precheck/scanner.ts` (skim últimas ~200 linhas; expor onde DDD é extraído)
6. `packages/core/src/api/quality.ts` (já tem agregação por cohort/carrier/DDD — modelo de referência pra novos endpoints)
7. `packages/ui/src/App.tsx` (estrutura de tabs; onde encaixar `<Geolocation/>`)

E em paralelo:

```bash
git log --oneline -15           # ver últimos commits (Sprint 1-3 + bugfixes)
ssh root@dispatch 'sqlite3 /var/www/debt-adb-framework/packages/core/dispatch.db ".tables" | tr " " "\n" | grep -iE "wa_contact|message_history|hygiene|wa_contact_checks|pipedrive_"'
```

## Skills obrigatórias (importar e invocar em ordem)

1. **`superpowers:brainstorming`** — Fase 0 (alinhamento de scope antes de pesquisar)
2. **`/var/www/amaral-intern-hub/.claude/skills/research/SKILL.md`** — pesquisa estruturada com subagents paralelos. Siga padrão "Comparação de alternativas" + "Mapeamento de codebase"
3. **`superpowers:dispatching-parallel-agents`** — protocolo pra fan-out em UMA mensagem com múltiplos `Agent` tool_uses
4. **`superpowers:writing-plans`** — Fase 4 (síntese final em formato de plano TDD-ready)
5. **`feature-dev:code-explorer`** — Fase 2 (auditoria interna de aggregations + endpoints já existentes)
6. **`frontend-design:frontend-design`** — Fase 3 (gerar mockups + escolher lib de mapa; esta feature é visual-heavy)
7. **`tdd`** — Fase 5 (red → green por endpoint + componente)

Não use skills de geração full-stack (`feature-dev:feature-dev`) — vamos quebrar manualmente em backend/frontend/research/spec.

## State machine

```
                ┌─────────────────────────────────────────┐
                │                                         │
                ▼                                         │
   ┌──────────────────────┐                              │
   │  PHASE_0_ALIGN       │  brainstorming — 3-4 perguntas via
   │  (brainstorming)     │  AskUserQuestion: scope (estados vs DDDs),
   │                      │  lib mapa (react-simple-maps vs leaflet vs
   │                      │  deck.gl), aba global sim/não, polling vs
   │                      │  snapshot, prioridade vs Sprint 5
   └──────┬───────────────┘
          │ approve scope
          ▼
   ┌──────────────────────┐
   │  PHASE_1_RESEARCH    │  4 subagents paralelos:
   │  (parallel)          │   T1: lib mapa (alternativas + custo + LOC + license)
   │                      │   T2: BR topology (IBGE TopoJSON + DDD geometry sources)
   │                      │   T3: heatmap engines (Mapbox heat / leaflet.heat / d3-contour / deck.gl heatmap)
   │                      │   T4: UX references (Mapbox demos, Kepler.gl, Carto, Twilio insights, Stripe Radar)
   └──────┬───────────────┘
          │ findings consolidated
          ▼
   ┌──────────────────────┐
   │  PHASE_2_AUDIT       │  1 subagent Explore:
   │  (audit interno)     │   - mapear DDD-extraction existente
   │                      │   - identificar quais tabelas/endpoints tem dados por phone
   │                      │   - verificar pré-existência de índice em substr(phone,3,2)
   │                      │   - confirmar Pipeboard lookupDeals retorna phone identifiable
   └──────┬───────────────┘
          │ data sources confirmed
          ▼
   ┌──────────────────────┐
   │  PHASE_3_DESIGN      │  frontend-design + writing-plans:
   │  (mockup + plan)     │   - 3 mockups: layout aba + heatmap + drill table
   │                      │   - file structure (componentes + endpoints + tipos)
   │                      │   - decompor em ≥6 tasks TDD-ready (red→green→commit)
   └──────┬───────────────┘
          │ plan written + approved
          ▼
   ┌──────────────────────┐
   │  PHASE_4_BACKEND     │  TDD por endpoint:
   │  (3-4 endpoints)     │   - /api/v1/geo/oralsin/sends
   │                      │   - /api/v1/geo/precheck/:outcome
   │                      │   - /api/v1/geo/pipedrive/mapped
   │                      │   - /api/v1/geo/senders (pontos)
   └──────┬───────────────┘
          │ green tests + build OK
          ▼
   ┌──────────────────────┐
   │  PHASE_5_FRONTEND    │  TDD por componente:
   │                      │   - BrazilMap (topology + render)
   │                      │   - HeatmapLayer
   │                      │   - PointsLayer
   │                      │   - PluginTabs (oralsin / adb-precheck / global)
   │                      │   - FilterBar (window + status + outcome)
   │                      │   - DrillTable (clica DDD → modal)
   └──────┬───────────────┘
          │ UI build clean
          ▼
   ┌──────────────────────┐
   │  PHASE_6_DEPLOY      │  build + push + ssh dispatch pull/build/restart
   │                      │  + smoke (endpoints respondem, UI renderiza,
   │                      │  drill funciona). Tira screenshot.
   └──────┬───────────────┘
          │ live em prod
          ▼
   ┌──────────────────────┐
   │  PHASE_7_GATE        │  quality gates (ver abaixo); update progress.md;
   │                      │  commit final; cria task de follow-ups.
   └──────────────────────┘
```

## Grafo de dependências dos subagents (Fase 1)

```
T1 (mapa) ──┐
            ├──► T_synthesis_research (você)
T2 (topo) ──┤
            │
T3 (heat) ──┤
            │
T4 (UX) ────┘

T1..T4 paralelizáveis. UMA mensagem, 4 tool_uses Agent simultâneos.
T5 (audit interno) na PHASE_2, separado, depende dos findings de T1..T4
pra saber se a lib escolhida combina com dados disponíveis.
```

## Especificação dos subagents

### T1 — Map library research (general-purpose + WebSearch)

```
Pesquise + compare 5 libraries pra renderizar mapa do Brasil em React 19 + Vite:

  - react-simple-maps (SVG, leve, declarative)
  - leaflet + react-leaflet (raster tiles, plugin ecosystem)
  - deck.gl (WebGL, performance alta, layers compostas)
  - kepler.gl (Uber, especializado em geo + heatmap)
  - mapbox-gl (token comercial; verificar se token gratuito basta pra prototype)

Para CADA:
- Bundle size impact (gzipped)
- Suporte a heatmap nativo OU plugin
- Suporte a topology custom (precisamos GeoJSON/TopoJSON do BR)
- Suporte a tooltip + click handlers
- License (MIT/Apache vs commercial)
- React 19 compatibility (alguns ainda travados em React 18)
- Maintenance status (último commit, releases 2026)

Output: tabela comparativa + recomendação rankeada com rationale. Cap 700 palavras. STATUS: ANSWERED|PARTIAL|UNABLE.
```

### T2 — BR topology data (general-purpose + WebSearch)

```
Encontre datasets de geometria do Brasil utilizáveis em mapa SVG/canvas:

1. Estados (27 features) — TopoJSON oficial IBGE. Verificar tamanho do arquivo (kb).
2. Municípios (~5570) — overkill mas vale saber se existe.
3. **DDDs (~66) — CRÍTICO**. Mapeamento DDD → polígono OU DDD → conjunto de municípios.
   Buscar:
   - codeforamerica/click_that_hood
   - github topojson brazil ddd
   - QGIS / IBGE Anatel DDD mapping
   - Algum dataset Kaggle com DDD geometry

Para cada source:
- URL canônica + license (CC-BY/CC0?)
- Formato (TopoJSON, GeoJSON, Shapefile)
- Tamanho do arquivo
- Versão das fronteiras (atual?)
- Como integrar no Vite (import + parse)

Output: 3-5 sources priorizados + sample de DDD→polygon. Cap 500 palavras. STATUS.
```

### T3 — Heatmap engines (general-purpose + WebSearch + WebFetch)

```
Compare técnicas de heatmap para mapa do BR com DDDs como bins:

  - Choropleth (cor uniforme por DDD baseada em valor) — mais simples
  - Density heatmap (interpolação contínua via kernel density)
  - Hexbin / square bin
  - Points + radius + color

Bibliotecas candidatas:
  - leaflet.heat
  - deck.gl HeatmapLayer
  - d3-contour
  - mapbox-gl heat
  - react-leaflet-heatmap-layer

Para CADA:
- Computação client-side vs server-side (qual quantia de dados aguenta?)
- Color scales recomendadas (chroma.js / d3-scale-chromatic Viridis/Magma)
- Performance pra 66 DDDs × 4 plugins × 30 dias de dado agregado
- Acessibilidade (color-blind safe?)

Output: recomendação técnica + exemplo de código. Cap 600 palavras. STATUS.
```

### T4 — UX references (general-purpose + WebSearch)

```
Pesquise 5 produtos com geo-analytics maduros + extraia padrões UX aplicáveis:

  - Mapbox demos (heatmap-layer, choropleth)
  - Kepler.gl
  - Carto Builder
  - Twilio Messaging Insights geo view
  - Stripe Radar / Sigma geographic distribution
  - Datadog Geographic Map widget

Para CADA:
- Como filtros temporais são apresentados (sidebar? top bar? drawer?)
- Tooltips on hover — o que mostram?
- Drill-down pattern (click em región → modal? side panel? new tab?)
- Legend placement (sempre visível? collapsable?)
- Aba/plugin switching pattern

Output: 5 padrões recurrent + 3 propostas concretas pra Dispatch. Cap 500 palavras. STATUS.
```

### T5 — Audit interno (Explore "very thorough")

```
Audite o codebase pra confirmar onde extrair dados pro mapa:

1. DDD extraction:
   - existe helper que extrai DDD de phone? grep "ddd\|DDD\|extractDdd"
   - se sim, é idempotente para formatos 13 vs 11 dígitos? (memory: normalization mismatch)
   - se não, precisa criar

2. Tabelas com phone agregável:
   - message_history.from_number / to_number — formato? índice por DDD viável?
   - wa_contact_checks.phone_normalized — index existe? SCHEMA
   - hygiene_job_items — phone + outcome
   - adb_precheck_deals.contato_* — phone retrievable?
   - pipedrive_activities / pipedrive_notes — phone reference?

3. Endpoints existentes que façam GROUP BY:
   - /api/v1/quality/cohort já agrupa por DDD! Validar reuso.
   - Outros aggregators existentes

4. Senders (pra plotar pontos): sender_mapping tem latitude/longitude? Provavelmente não — vamos derivar do DDD.

Output: 8-bucket framework — pra cada item:
  EXISTE-PRONTO / EXISTE-MAS-PRECISA-INDEX / PRECISA-CRIAR
+ file:line evidência + recommendation pra cada caso.

Cap 700 palavras. STATUS: ANSWERED.
```

## Quality gates (Phase 7)

Antes de fechar a sessão:

- [ ] **Cobertura**: aba Geolocalização tem tabs Oralsin + Adb-precheck + (opcional Global)
- [ ] **Filtros**: window (24h/7d/30d) + status/outcome funcionam
- [ ] **Drill**: click em DDD abre tabela de phones daquele DDD (paginated)
- [ ] **Endpoints**: 3-4 endpoints respondem com `{ddd: count}` (HTTP 200, tested via curl)
- [ ] **Backend tests**: ≥5 testes pra agregações (cobertura de edge cases: DDD inválido, phone 11 vs 13 dígitos)
- [ ] **UI**: bundle build clean, no console errors em prod
- [ ] **A11y**: legend tem aria-label, heatmap tem fallback table view
- [ ] **Deploy**: HEAD local = origin/main = Kali; services active; smoke OK
- [ ] **Screenshot**: salvar em `reports/2026-05-14-geolocation-tab.png` pra audit trail

## Hard rules

- **Antes de implementar**: a Fase 0 brainstorming TEM que rodar — design decisions de lib + topology pesam o resto da sessão
- **Subagents read-only**: T1-T5 retornam relatórios; quem escreve arquivos é só você (orquestrador)
- **Commits granulares**: 1 commit por endpoint backend + 1 por componente UI maior
- **Sem código sem teste verde**: TDD red → green → commit, sem batches grandes
- **Cap de 4 iterações de refinamento** em qualquer subagent dispatch
- **Não modificar plugins existentes** sem necessidade direta — esta feature LÊ dados, não muda contratos
- **Performance budget**: agregações devem retornar em <500ms; usar índice se necessário (índice em substr(phone,3,2) pode ser caro — considerar coluna `ddd` denormalizada)

## Outputs esperados

1. **`docs/strategy/2026-05-14-geolocation-spec.md`** — spec final após brainstorming + audit
2. **`docs/strategy/2026-05-14-geolocation-research-sessions/`** — diretório com T1-T5 + state.json
3. **Código**:
   - `packages/core/src/api/geo.ts` — endpoints aggregation
   - `packages/core/src/util/ddd.ts` — DDD extraction helper (se preciso criar)
   - `packages/ui/src/components/geo/` — componentes (BrazilMap, HeatmapLayer, etc)
   - `packages/ui/src/components/geo-page.tsx` — root component
   - `packages/ui/public/topology/br-ddds.json` — TopoJSON do BR por DDD
   - Testes colocados (.test.ts/.test.tsx)
4. **Git commits**:
   - `feat(geo): aggregation endpoints for plugin geographic distribution`
   - `feat(geo-ui): BrazilMap component + heatmap layer`
   - `feat(geo-ui): plugin tabs + filter bar + drill table`
   - `feat(geo): wire into App.tsx + deploy`
5. **Push** pra `origin/main` (não force) + deploy em Kali via SSH

## Estado inicial sugerido pra `state.json`

```json
{
  "session_id": "geolocation-2026-05-14",
  "currentPhase": "PHASE_0_ALIGN",
  "iterations": 0,
  "decisions": {
    "map_lib": null,
    "topology_source": null,
    "heatmap_engine": null,
    "include_global_tab": null,
    "polling_seconds": null
  },
  "tracks": {
    "T1": { "status": "pending", "topic": "map library comparison" },
    "T2": { "status": "pending", "topic": "BR DDD topology" },
    "T3": { "status": "pending", "topic": "heatmap engines" },
    "T4": { "status": "pending", "topic": "geo UX references" },
    "T5": { "status": "pending", "topic": "internal audit aggregation sources" }
  },
  "gates": {
    "coverage": false, "filtros": false, "drill": false,
    "endpoints": false, "backend_tests": false, "ui": false,
    "a11y": false, "deploy": false, "screenshot": false
  },
  "started_at": null,
  "completed_at": null
}
```

## Bloqueadores conhecidos (vindos do v2 §8 + Sprint 1-3)

- **L2 GTM**: se essa aba virar argumento de venda, GTM model precisa estar definido pra calibrar (per-device dashboard? per-DDD insight como produto?). Não bloqueia ship técnico mas pode aparecer no design.
- **Pipeboard normalization**: DDD extraction deve tolerar 12 vs 13 dígitos (Sprint 1 bug #2 documentou). Helper precisa ser idempotente.
- **3 sessions WAHA SCAN_QR_CODE** (task #6 da sessão anterior): irrelevante pra esta feature (que lê dados históricos).

## Como começar

1. Em uma mensagem: 8 `Read` tool_uses em paralelo (todos os arquivos de contexto)
2. `superpowers:brainstorming` skill invocada
3. AskUserQuestion com 1-3 perguntas críticas (scope + prioridade + GTM relevance)
4. Após OK do user, em UMA mensagem: 4 `Agent` tool_uses paralelos (T1-T4)
5. Quando retornam, dispatch T5 (depende dos findings de T1-T4)
6. Sintetize → spec → plan → backend TDD → frontend TDD → deploy
7. Cada PHASE marca tasks via TaskCreate/TaskUpdate

**Não comece a codar antes de ter scope alinhado E lib de mapa escolhida.** O custo de trocar lib mid-stream é alto.

---

## Referência rápida pro orquestrador da próxima sessão

| Estado prod atual (fim sessão 2026-05-12) | Valor |
|---|---|
| HEAD | `fe671933` |
| Sprints completas | 1, 2 (MVP), 3 (MVP) |
| Sprints pendentes do v2 | 4 (perf), 5 (differentiation) |
| Esta feature (Geolocalização) | NÃO está no v2 §7 — capturada hoje à parte |
| Plugins ativos | oralsin, adb-precheck (manifest_ok) |
| Devices online | 1/2 (POCO Serenity); 3 sessions WAHA em SCAN_QR_CODE |
| Bugs abertos | 0 (Sprint 1 + 3 bugfixes deployed) |
| Open questions | L1 onboarding, L2 GTM, L3 Lei Superendividamento, L4 DR, L5 Avisa UX |

Boa sorte. Vai dar certo.
