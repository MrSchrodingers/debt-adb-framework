# Prompt para a próxima sessão — Roadmap v2 (validação + expansão)

> **Como usar**: cole o bloco abaixo (entre as linhas `=== BEGIN/END PROMPT ===`) em uma nova sessão do Claude Code no repositório `/var/www/adb_tools`. Não edite o conteúdo — o prompt é projetado para ser auto-contido, com state machine, grafo de execução, dispatching de subagents e quality gates definidos explicitamente.

---

## === BEGIN PROMPT ===

### Identidade da sessão

Você é o orquestrador de uma sessão de **validação e expansão de roadmap** para o projeto Dispatch (DEBT ADB Framework), repo em `/var/www/adb_tools`. O documento `docs/strategy/2026-05-12-feature-roadmap-and-market-analysis.md` foi produzido em uma sessão anterior. Sua tarefa é **validar cada claim, aprofundar a evidência, e produzir uma v2 do roadmap com correções/adições onde a pesquisa apontar gaps**.

A sessão deve operar como state machine com fases sequenciais e dependências explícitas entre subagents. Você NÃO deve começar a executar trabalho de implementação — apenas pesquisa, validação, síntese e documentação.

### Skills a importar e invocar

Antes de qualquer trabalho, importe e use as seguintes skills:

1. **`/var/www/amaral-intern-hub/.claude/skills/research/SKILL.md`** — pesquisa estruturada com subagents paralelos. Leia-a e siga o protocolo: decomposição → dispatching paralelo em uma única mensagem → síntese > concatenação. Use o padrão "Validação de claim" + "Comparação de alternativas" + "Descoberta de contexto" conforme a fase.

2. **`superpowers:brainstorming`** — para a Fase 0 (alinhamento de intent antes de pesquisar).

3. **`superpowers:writing-plans`** — para a Fase 4 (síntese final em formato de plano).

4. **`feature-dev:code-explorer`** — para a Fase 2 (auditoria interna do estado real do código).

5. **`superpowers:dispatching-parallel-agents`** — protocolo para garantir que dispatches paralelos saiam em uma única mensagem com múltiplos `Agent` tool_uses (não sequenciais).

Não use skills de geração de código (`tdd`, `feature-dev:feature-dev`) — esta sessão é pesquisa e documentação, não implementação.

### Contexto obrigatório a carregar antes da Fase 0

Leia, em paralelo (uma mensagem com múltiplos `Read` tool_uses):

1. `docs/strategy/2026-05-12-feature-roadmap-and-market-analysis.md` (roadmap v1, ~350 linhas)
2. `docs/PRD-dispatch.md` (declaração de problema + arquitetura)
3. `docs/research-ban-risk-reality.md` (research interna de 2026-04 sobre detecção server-side WA)
4. `docs/research-consolidated-findings.md` (16 testes no device físico, técnicas que funcionam/não funcionam)
5. `.dev-state/progress.md` (estado atual do projeto)
6. `CLAUDE.md` (workflow obrigatório do projeto)

E em paralelo, mapeie o git para entender a deriva entre o roadmap (2026-05-12) e hoje:

```bash
git log --oneline --since="2026-05-12" -- docs/ packages/
```

Se houver commits após 2026-05-12 que modifiquem áreas do roadmap (anti-ban, plugins, UI), eles têm precedência sobre o roadmap em caso de conflito.

### State machine

```
                ┌─────────────────────────────────────────┐
                │                                         │
                ▼                                         │
   ┌──────────────────────┐                              │
   │  PHASE_0_ALIGN       │  user intent + scope clarification
   │  (brainstorming)     │  via AskUserQuestion (1-3 perguntas)
   └──────┬───────────────┘
          │ approve scope
          ▼
   ┌──────────────────────┐
   │  PHASE_1_DECOMPOSE   │  break the v1 roadmap into 5 research tracks
   │  (you, no subagents) │  emit dependency graph (this doc)
   └──────┬───────────────┘
          │ tracks ready
          ▼
   ┌──────────────────────────────────────────┐
   │  PHASE_2_RESEARCH (parallel — 5 tracks)  │
   │  ┌─────────────┬─────────────┬────────┐  │
   │  │ T1: anti-ban│ T2: market  │ T3: UX │  │
   │  │ deep-dive   │ comp v2     │ patterns│ │
   │  └─────────────┴─────────────┴────────┘  │
   │  ┌─────────────┬─────────────┐           │
   │  │ T4: plugin  │ T5: internal│           │
   │  │ arch        │ audit       │           │
   │  └─────────────┴─────────────┘           │
   └──────┬───────────────────────────────────┘
          │ all tracks STATUS: ANSWERED/PARTIAL
          ▼
   ┌──────────────────────┐
   │  PHASE_3_CROSS_VAL   │  cross-validation pass:
   │  (2 subagents)       │   - V1: conflicts/divergences across tracks
   │                      │   - V2: claim-by-claim verification of roadmap v1
   └──────┬───────────────┘
          │ findings collated
          ▼
   ┌──────────────────────┐
   │  PHASE_4_SYNTHESIZE  │  produce roadmap v2:
   │  (you, with          │   - PATCH (additions/corrections to v1)
   │   writing-plans)     │   - DELTA (full diff for clarity)
   │                      │   - DECISIONS LOG
   └──────┬───────────────┘
          │ draft ready
          ▼
   ┌──────────────────────┐
   │  PHASE_5_QA_GATE     │  quality gates (see below) → if FAIL go back to PHASE_2 with focused track
   └──────┬───────────────┘
          │ pass
          ▼
   ┌──────────────────────┐
   │  PHASE_6_COMMIT      │  git commit + push
   └──────────────────────┘
```

### Grafo de dependências entre tracks (Fase 2)

```
T1 (anti-ban) ──┐
                ├──► T6 (cross-val V1: divergências)
T2 (market) ────┤
                │
T3 (UX) ────────┤
                │
T4 (plugin) ────┤
                │
T5 (audit) ─────┘
T5 (audit) ──────► T7 (cross-val V2: roadmap-v1 claim check)

T1..T5: paralelizáveis. UMA mensagem, 5 tool_uses Agent simultâneos.
T6, T7: sequenciais APÓS T1..T5. UMA mensagem, 2 tool_uses Agent simultâneos.
```

### Especificação de cada track

**T1 — Anti-ban deep-dive** (subagent type: `general-purpose` com WebSearch + WebFetch)

Prompt do subagent:
> Valide e expanda os 10 gaps anti-ban identificados em `docs/strategy/2026-05-12-feature-roadmap-and-market-analysis.md` §4. Para cada gap, busque:
> 1. Evidência atual (2026) de que o gap ainda é real — alguma mudança no WhatsApp client que invalida?
> 2. Implementações conhecidas/funcionais — repos open-source, blog posts, papers, talks de DEF CON / Black Hat
> 3. Risco específico contextual (BR cobrança, volume 5k/dia, devices rooted)
> 4. Novos vetores anti-ban que NÃO estão no roadmap v1 mas deveriam — pesquise:
>    - WhatsApp Multi-Device protocol changes 2026
>    - PlayIntegrity attestation evolution
>    - Bizapp signatures, BizIntegritySignals
>    - Behavioral biometrics (touch dynamics, scroll patterns)
>    - Network-layer fingerprints (TLS JA3/JA4 from device)
>
> Cite URLs específicas. Termine com STATUS: ANSWERED/PARTIAL/UNABLE. Cap 800 palavras.

**T2 — Market competitive analysis v2** (subagent type: `general-purpose` com WebSearch)

Prompt:
> O roadmap v1 §2 lista concorrentes (Bịp Device, WPPConnect, Evolution API, Whaticket, Z-API, Maytapi, Twilio, Blip, MaturaGo, ProtectZap, ZapSimples, Clickmassa). Faça pesquisa adicional para:
> 1. **Releases / pricing changes** desses produtos nos últimos 60 dias
> 2. **Concorrentes novos** que entraram no mercado BR após 2026-03-01 (busque: "disparo massa whatsapp 2026", "chip warmup brasil 2026", "device farm whatsapp 2026")
> 3. **Funcionalidades anti-ban ESPECÍFICAS** que cada concorrente anuncia mas o Dispatch NÃO tem
> 4. **Reclamações recentes** (Reddit, GitHub issues, Reclame Aqui) sobre cada um
> 5. **Pricing model trends** — Meta API custo evolução 2026
> 6. **Quais ferramentas que CRMs brasileiros (Pipedrive, Bitrix24, RD Station) recomendam** para WhatsApp outbound mass
>
> Output: matriz atualizada de features × concorrentes (incluindo Dispatch), com células marcadas ✓/✗/?/N/A. Identifique 3-5 features que NENHUM concorrente tem (oportunidade de moat). STATUS: ANSWERED/PARTIAL/UNABLE. Cap 800 palavras.

**T3 — UX patterns deep-dive** (subagent type: `general-purpose` com WebSearch + WebFetch)

Prompt:
> Pesquise padrões de UX para 3 jornadas críticas do Dispatch, comparando com top-tier products:
>
> 1. **Operator dashboard de envio em massa** — referências: Twilio Console, Maytapi dashboard, Pipedrive Mass Outreach, Mailchimp campaigns, Klaviyo flows
> 2. **Device fleet management** — referências: Browserstack App Live, Sauce Labs, AWS Device Farm, GeeLark, BlueStacks Multi-Instance Manager
> 3. **Compliance/audit dashboard** — referências: Vanta, Drata, ISMS dashboards, banking ops consoles
>
> Para cada jornada:
> - Identifique 3-5 padrões de UX recorrentes nos produtos de referência
> - Compare com o que o Dispatch tem hoje (consulte `packages/ui/src/components/` se necessário)
> - Aponte 3 gaps específicos onde o Dispatch poderia adotar padrões
> - Cite URLs/screenshots/blog posts
>
> Não fique no abstrato — quero "Pipedrive usa cohort panel sticky no topo com filter chip dropdown", não "boa UX é importante". STATUS: ANSWERED/PARTIAL/UNABLE. Cap 700 palavras.

**T4 — Plugin architecture deep-dive** (subagent type: `general-purpose` com WebSearch + Read interno)

Prompt:
> O roadmap v1 §5 (Tier 1) propõe extrair Pipedrive como serviço compartilhado entre plugins e isolar Oralsin do core. Pesquise:
>
> 1. **Plugin SDK patterns em produtos similares** — VS Code Extensions, Backstage plugins, Datadog integrations, Sentry SDK, n8n integrations
> 2. **Como esses produtos resolvem**: shared services (cache de auth, rate-limit pool, logging), isolation (sandbox vs trust), hot-reload, versioning, lifecycle
> 3. **Específicos para o caso Dispatch**:
>    - Como o `PluginContext` atual (`packages/core/src/plugins/types.ts`) se compara ao `BackstagePluginContext` ou `vscode.ExtensionContext`?
>    - Hot-reload de plugin sem restart de core — viável? Que produtos suportam?
>    - Como expor Pipedrive como `ctx.pipedrive.createNote(...)` sem que cada plugin re-implemente o cliente HTTP?
> 4. **Anti-patterns conhecidos** — onde plugin systems geralmente falham (god context, sync hooks bloqueando hot path, etc)
>
> Cite repos/docs. Sugira 3 design decisions concretas para a v2 do roadmap. STATUS: ANSWERED/PARTIAL/UNABLE. Cap 700 palavras.

**T5 — Internal audit v2** (subagent type: `Explore`, modo "very thorough")

Prompt:
> Re-audite o codebase para verificar 10 claims específicos do roadmap v1 que precisam de validação direta no código:
>
> 1. (`§3`) `contatos` tab tem 528 linhas e é read-only? Quais endpoints existem mas não são chamados? (verifique `/api/v1/contacts/recheck` em particular)
> 2. (`§3`) `fleet-page.tsx` tem 2175 linhas? Quantos sub-componentes seria razoável decompor? Quais já existem em `packages/ui/src/components/fleet-*`?
> 3. (`§3`) `admin-page.tsx` tem dead-letter callbacks, banned numbers, sender controls? O que mais?
> 4. (`§4`) `entryPointSource` é 100% `wa.me?text=` em `send-engine.ts`? Cite file:line.
> 5. (`§4`) `sender:quarantined` event existe no socket mas não é emitido pelo engine? Cite file:line.
> 6. (`§5 Tier 0 A2`) On-device script de fato traria -30%? Existe stub/dead code mencionando `/data/local/tmp/send.sh`?
> 7. (`§5 Tier 1 B2`) `pipedrive-*.ts` vive apenas em `plugins/adb-precheck/`? Liste cada arquivo + LOC.
> 8. (`§5 Tier 2 C1`) Os 3 scripts Python (`resolve_no_match.py`, `tombstone_deleted.py`, `rescan_active_stale.py`) existem em algum lugar do repo? Onde?
> 9. (`§5 Tier 3 D5`) Existe alguma infra de export LGPD hoje (Audit log, message_history dump endpoint)?
> 10. (`§7`) `aggregatePhoneStatsTruth` realmente trata tombstoned como inclusive? Cite o commit `7b0b593a` que claim isso.
>
> Output: para cada claim, **VERIFIED / FALSE / PARTIAL** + file:line + nota curta. Cap 600 palavras. STATUS: ANSWERED.

**T6 — Cross-validation V1 (divergências)** (subagent type: `general-purpose`)

Depende de T1..T5 completos. Prompt:
> Recebe os outputs de T1, T2, T3, T4, T5 (cole-os no início do prompt). Identifique:
> 1. **Conflitos diretos** — onde 2+ tracks discordam sobre um fato
> 2. **Falsificações** — onde T5 (audit interno) contradiz claims de T1/T2/T3/T4
> 3. **Confluências** — onde 3+ tracks chegam à mesma conclusão (alta confiança)
> 4. **Lacunas** — perguntas que NENHUM track respondeu
>
> Output: lista priorizada de 5-10 itens, cada um com (tipo, claim, evidência, decisão recomendada para v2). Cap 500 palavras.

**T7 — Cross-validation V2 (roadmap v1 claim check)** (subagent type: `general-purpose`)

Depende de T1..T5 completos. Prompt:
> Pegue o roadmap v1 `docs/strategy/2026-05-12-feature-roadmap-and-market-analysis.md`. Para cada item das Sprints 1-5 (Tier 0 ao Tier 4), avalie usando os outputs de T1..T5:
> - **KEEP** — claim resiste à validação
> - **REVISE** — claim parcialmente correto, ajustar (descreva como)
> - **DROP** — claim é falso ou superada por evidência nova
> - **ADD** — itens novos descobertos nos tracks que não estão na v1
>
> Output: tabela markdown com (item, decisão, justificativa, ação concreta). Cap 600 palavras.

### Quality gates (Phase 5)

Antes de commitar v2, valide:

- [ ] **Cobertura**: cada um dos 10 gaps anti-ban do v1 tem decisão (KEEP/REVISE/DROP) com evidência citada
- [ ] **Novidades**: pelo menos 5 itens NOVOS (ADD) que não estavam no v1, com fonte
- [ ] **Concorrência**: matriz de features × concorrentes atualizada e citando URLs (não memória)
- [ ] **UX**: cada uma das 3 jornadas críticas tem 3+ padrões concretos referenciados
- [ ] **Plugin arch**: pelo menos 3 design decisions concretas (não "fica melhor")
- [ ] **Internal audit**: 10/10 claims do v1 verificados como VERIFIED/FALSE/PARTIAL
- [ ] **Cross-val**: pelo menos 1 falsificação documentada (se zero, suspeitar de viés confirmatório)
- [ ] **Format**: documento v2 em `docs/strategy/2026-05-13-feature-roadmap-v2.md`, com seção `## Diff vs v1` listando KEEP/REVISE/DROP/ADD por item
- [ ] **Plan format**: usar `superpowers:writing-plans` para a seção de roadmap final (Sprints 1-5 atualizadas)
- [ ] **Sources**: cada claim crítico tem ≥1 URL/file:line/commit hash; nenhum claim "à memória"

Se algum gate falhar, identifique qual track precisa ser refeito e volte para PHASE_2 com prompt focado.

### Outputs esperados

1. **`docs/strategy/2026-05-13-feature-roadmap-v2.md`** — documento v2 completo
2. **`docs/strategy/2026-05-13-research-sessions/`** — diretório com:
   - `T1-anti-ban.md`
   - `T2-market.md`
   - `T3-ux.md`
   - `T4-plugin-arch.md`
   - `T5-internal-audit.md`
   - `T6-cross-val-divergences.md`
   - `T7-cross-val-roadmap.md`
   - `state.json` (state machine final, para auditoria/handoff)
3. **Git commit** no formato `docs(strategy): roadmap v2 — validation + expansion via 5-track research` com co-author tag e push para `origin/main`

### Como começar

1. Carregue contexto obrigatório em uma mensagem com múltiplos `Read` tool_uses.
2. Invoque `superpowers:brainstorming` para a Fase 0 (alinhar comigo se o scope está correto antes de gastar tokens em subagents).
3. Após meu OK, emita a lista de 5 tracks com `superpowers:dispatching-parallel-agents` em UMA mensagem.
4. Quando todos retornarem, dispatche T6 e T7 em UMA mensagem (paralelos entre si).
5. Sintetize, valide com os quality gates, escreva v2.
6. Pergunte-me se concorda com a v2 antes de commit. Não force push sem aprovação.

### Hard rules

- **Nenhuma modificação em código de produção** nesta sessão — apenas leitura.
- **Nenhuma chamada destrutiva** (force-push, drop, delete) sem confirmação explícita.
- **Nenhum subagent recebe permissão de Write/Edit** — todos read-only (`Explore`, ou `general-purpose` sem flag de escrita).
- **Cap de 4 iterações de refinamento** após PHASE_2 inicial — se ainda há divergência depois disso, documente a divergência como "open question" e siga.
- **Nenhum claim em memória** — se vou afirmar "Pipedrive cobra X", quero a URL citada.
- **Idempotência**: se a sessão for interrompida, ao retomar, leia `state.json` e retome da fase salva.

### Estado inicial sugerido para `state.json`

```json
{
  "session_id": "roadmap-v2-2026-05-13",
  "currentPhase": "PHASE_0_ALIGN",
  "iterations": 0,
  "tracks": {
    "T1": { "status": "pending", "subagent_type": "general-purpose" },
    "T2": { "status": "pending", "subagent_type": "general-purpose" },
    "T3": { "status": "pending", "subagent_type": "general-purpose" },
    "T4": { "status": "pending", "subagent_type": "general-purpose" },
    "T5": { "status": "pending", "subagent_type": "Explore" },
    "T6": { "status": "pending", "subagent_type": "general-purpose", "depends_on": ["T1","T2","T3","T4","T5"] },
    "T7": { "status": "pending", "subagent_type": "general-purpose", "depends_on": ["T1","T2","T3","T4","T5"] }
  },
  "gates": {
    "coverage": false, "novidades": false, "concorrencia": false,
    "ux": false, "plugin_arch": false, "internal_audit": false,
    "cross_val": false, "format": false, "plan_format": false, "sources": false
  },
  "started_at": null,
  "completed_at": null
}
```

---

Comece pela Fase 0. Espere meu input.

## === END PROMPT ===

---

## Notas para você (operador), antes de colar

- **Sessão isolada**: abra uma nova janela do Claude Code (não continue esta). O prompt acima é projetado pra ser standalone.
- **Tempo estimado**: PHASE_0 (5 min) + PHASE_2 paralelo (3-5 min de subagents simultâneos) + PHASE_3 cross-val (~2 min) + PHASE_4 síntese (10-15 min escrevendo) + PHASE_5 gates + commit. Total: 30-45 min de wall-clock.
- **Custo**: 5 subagents paralelos + 2 cross-val. Cada subagent tipicamente 5-15k tokens. Estimativa: ~80-150k tokens total para a sessão. ≈ U$ 1-3 dependendo do mix de modelo.
- **Interrupção**: o prompt tem ponto de recuperação (`state.json`). Se cair no meio, retome com "retome a session roadmap-v2-2026-05-13".
- **Personalização opcional**: se quiser focar em apenas 2-3 dos tracks (e.g. só anti-ban + plugin arch), edite a lista de tracks na seção "Especificação de cada track" antes de colar.
- **Skill amaral-intern-hub**: confirme que `/var/www/amaral-intern-hub/.claude/skills/research/SKILL.md` ainda existe. Se moveram, ajuste o caminho no início do prompt.
