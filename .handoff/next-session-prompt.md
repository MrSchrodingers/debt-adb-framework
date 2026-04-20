# Prompt para Iniciar Nova Sessão — Anti-Fingerprint Hardening

Cole este texto no início da conversa com o próximo agente:

---

## Contexto

Estou trabalhando no **DEBT ADB Framework (Dispatch)** — um sistema de envio de mensagens WhatsApp via ADB em devices Android rooteados. O projeto é um monorepo TypeScript (Node.js 22, Fastify, React 19, Electron) em `/var/www/adb_tools`.

### Estado atual

- **Branch:** `feat/anti-ban-scaling`, commit `aab96bc4`
- **705 testes** passando (1 flaky pré-existente em health-collector)
- **30+ commits** nesta sessão completando o Operational Hardening v2 (5 fases) + 9 melhorias + infra Prometheus/Grafana
- **E2E validado** com Oralsin: 18/19 callbacks 200 OK, 4 profiles Android testados
- Device: POCO C71 rooteado (Magisk 28.1), Unisoc T7250, `/dev/uhid` disponível, sendevent validado em `/dev/input/event3`

### O que precisa ser feito agora

Executar o plano em `docs/superpowers/plans/2026-04-10-anti-fingerprint-hardening.md`. São 8 tasks (P0 a P3) para eliminar fingerprints de automação do send engine do WhatsApp.

**Prioridades e dependências:**
```
P0-A (UIAutomator bounds) → P0-B (strategy weights) → P1-B (UHID proto)
P1-A (SharedPrefs fallback) — independente
P2-A (sendevent taps) — após P0-A
P2-B (contact aging) — independente
P3-A/B — quick wins
UI-A through UI-E — propagação frontend, após respectivos backends
```

### Como executar

1. Recupere contexto: `cat .dev-state/progress.md` e `cat .handoff/session-20260410-1630.json`
2. Leia o plano: `cat docs/superpowers/plans/2026-04-10-anti-fingerprint-hardening.md`
3. Use `superpowers:subagent-driven-development` para executar task por task
4. Comece pelo **P0-A** (eliminar coordenadas hardcoded)
5. Cada task tem acceptance criteria no final do plano

### Informações críticas do device

- Touchscreen: `/dev/input/event3`, ABS capabilities `261800000000000`
- ABS suportados: TRACKING_ID (57), POSITION_X (53), POSITION_Y (54), TOUCH_MAJOR (48). **SEM PRESSURE.**
- Sendevent batch (1 su -c com inline): **0ms** (vs 77ms do input tap)
- UHID: `/dev/uhid` existe, `CONFIG_UHID=y`
- SharedPrefs WA: acessível via `su -c cp` para `/sdcard/`, contém `cc=55` + `self_lid`
- sqlite3 NÃO instalado no device — pull DB para server e ler com better-sqlite3
- CPU governor: `uscfreq` (Unisoc proprietário, não suporta performance/powersave)
- Adbkit shell: buffer limitado para outputs longos, piped commands com su falham — use separate calls ou write to /sdcard/ first

### Cuidados anti-ban

A pesquisa completa está em `docs/research/whatsapp-anti-detection-fingerprints.md`. Os 3 maiores riscos:
1. **IME bypass** (input text não gera typing indicator) — UHID resolve (P1-B)
2. **wa.me pattern** (prefill abre chat com texto completo) — strategy weights resolve (P0-B)
3. **Contact→send imediato** — contact aging resolve (P2-B)

Execute na ordem do plano. O P0-A é bloqueante para P0-B e P2-A.
