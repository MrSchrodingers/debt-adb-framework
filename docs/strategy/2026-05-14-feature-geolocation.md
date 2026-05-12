# Feature: Aba Geolocalização — heatmaps + pontos no mapa do Brasil

> **Status**: capturada 2026-05-12 fim de sessão; pra ser refinada em sprint dedicado próxima sessão.
> **Sprint alvo**: pós Sprint 4 ou paralelo a Sprint 5 (depende de scope).

## Sumário em uma frase

Tab nova "Geolocalização" com mapa do Brasil (SVG/canvas) renderizando **heatmaps + pontos por DDD**, separada em **abas por plugin** (Oralsin / adb-precheck), com filtros de tipo de dado (existente, não existente, mapeado em Pipedrive, envios efetivados).

## Cenários alvo

### Aba Oralsin
- **Envios efetivados** (heatmap por DDD do destinatário): intensidade = volume últimas 24h/7d/30d
- **Pontos** = senders ativos plotados nos DDDs deles (ou device físico se geolocalização disponível)
- **Filtro de status**: sent / failed / cancelled / permanently_failed
- **Drill**: clica em DDD → tabela de mensagens daquele DDD

### Aba ADB-Precheck
- **Não existentes** (heatmap): DDDs com maior taxa de `rejected_no_match` na hygiene_jobs
- **Existentes** (heatmap): DDDs com maior taxa de `valid` em wa_contact_checks
- **Mapeados em Pipedrive** (heatmap): DDDs com mais deals reconciliados via lookupDeals (incluindo tombstoned vs ativo)
- **Filtro temporal**: janela 24h/7d/30d/all-time
- **Drill**: clica DDD → tabela de phones daquele DDD

### Aba "global" (opcional)
- Cross-plugin overlay: pra ver onde Dispatch atua vs onde Pipeboard tem deal mas Dispatch nunca enviou (gap de cobertura)

## Componentes técnicos a decidir

### Frontend
- **Library de mapa**: react-simple-maps (SVG, leve) vs leaflet (raster) vs deck.gl/kepler.gl (canvas, hardcore viz) vs mapbox-gl (precisa token comercial)
- **Heatmap engine**: Recharts não faz; leaflet.heat plugin / mapbox heat layer / d3-contour
- **BR topology**: TopoJSON IBGE oficial (estados, municípios) + tabela DDD → polígono. Existem datasets prontos no GitHub (ex: codeforamerica/click_that_hood)
- **Color scale**: chroma.js ou d3-scale-chromatic (sequenciais tipo Viridis pra heatmap)

### Backend
- **Aggregation endpoints novos**:
  - `GET /api/v1/geo/oralsin/sends?window=7d&status=sent` → `{ddd: count}`
  - `GET /api/v1/geo/precheck/{outcome}?window=7d` → outcome ∈ {valid, invalid, no_match, tombstoned}
  - `GET /api/v1/geo/pipedrive/mapped?window=7d` → `{ddd: deals_count}`
- **Cache**: agregações por DDD podem ser cacheadas em SQLite views materializadas ou Redis-style memo (a tabela `wa_contact_checks` tem 4157 rows hoje — query direta é OK)

### Data layer
- DDD extraction: helper já deve existir (`packages/core/src/plugins/adb-precheck/normalizer.ts` provavelmente — confirmar)
- Index check: `wa_contact_checks` precisa de índice em `(substr(phone_normalized, 3, 2))` ou denormalizar `ddd` column

### UX patterns referência
- Mapbox heatmap demo (https://docs.mapbox.com/mapbox-gl-js/example/heatmap-layer/)
- Kepler.gl (Uber)
- Carto Builder
- Cubeobs (BR — geoanalise eleitoral)
- Twilio messaging insights tem world map similar
- Stripe radar geographic distribution

## Decisões em aberto (pra grill)

1. **Mapa de DDDs ou municípios?** DDDs (~66) é granular o suficiente e tem topology pronta. Municípios (~5570) é overkill.
2. **Heatmap por estado ou por DDD?** DDD é mais útil operacionalmente (matches phone format) mas estado é mais "limpo" visualmente. Sugestão: começa por DDD.
3. **Pointer interativo?** Tooltip on hover com counts + click pra drill?
4. **Real-time?** Polling 30s ou snapshot estático? Polling é mais legal mas custa query repeat.
5. **Heatmap absoluto vs relativo?** Volume bruto (RJ/SP sempre vão dominar) vs por capita / por base (taxa). Provavelmente queremos relativo para "rejected_no_match" e absoluto para "envios".
6. **Pipedrive overlay?** Bloqueia em Pipeboard estar healthy + ter histórico de deals com phone com DDD identificável.

## Estimativa de esforço

| Componente | LOC | Risco |
|---|---|---|
| 3 aggregation endpoints (oralsin/precheck/pipedrive) | ~200 | Baixo (queries SQL simples) |
| Cache layer (opcional) | ~100 | Médio |
| Map component base (BrazilMap + DDD topology) | ~250 | Médio (depende lib escolhida) |
| Heatmap layer | ~150 | Médio |
| Points layer (senders/devices) | ~100 | Baixo |
| Tabs UI + filter selects | ~150 | Baixo |
| Drill table modal | ~150 | Baixo |
| Tests | ~150 | Baixo |
| **Total** | **~1250** | **Médio (média de 4 features Sprint 5)** |

## Onde encaixar no roadmap v2

Não está no v2 §7 (não foi enumerado). Sugestão: **Sprint 6 (novo)** focado em insights/analytics. OU encaixar como add-on do Sprint 5 §"Diferenciação" (E4 cost dashboard também é analytics).

## Bloqueadores externos

- L2 (GTM model): se vamos vender Dispatch, mapa geográfico é argumento forte de "veja sua operação espalhada pelo BR" — diferencial visual. Resolver L2 primeiro reforça prioridade desta feature.
- Pipeboard health: o overlay "mapeados em Pipedrive" depende do contrato `lookupDeals` retornar phone+DDD. Memory cita normalization mismatch 13 vs 11 dígitos — DDD extraction deve ser idempotente.
