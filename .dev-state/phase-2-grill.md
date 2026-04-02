# Phase 2 Grill — Decisões Tomadas
> Date: 2026-04-01/02
> Status: ✅ COMPLETO — 12/12 decisões resolvidas

## Decisões Confirmadas

### 1. Worker Model: Um worker por device
Cada device conectado ganha seu próprio worker loop independente. Sends paralelos em devices diferentes.

### 2. Disconnect mid-send: Retry imediato + send_phase tracking
- Retry imediato (pode ser disconnect momentâneo de USB)
- Se retry falha → marca como `failed`
- Novo campo `send_phase`: `queued → locked → typing_started → typing_complete → send_tapped → screenshot_taken → sent`
- Se disconnect após `send_tapped` → marcar `sent_unconfirmed`, NÃO reenviar
- Screenshot de cada envio salvo como prova auditável

### 3. Health retention: 7 dias no SQLite local
Cleanup cron apaga registros > 7 dias. Health data polled do device, armazenada no SQLite do Dispatch.

### 4. WA Account Mapper: Root + shared_prefs
- Ler `/data/data/com.whatsapp/shared_prefs/com.whatsapp_preferences_light.xml`
- Contém `registration_jid` com o número registrado
- Requer root no device (disponível com Magisk)
- Iterar por user profiles 0-3

### 5. Multi-profile: 4 users × (WA + WABA) por device
- Por device: até 4 user profiles Android
- Por profile: 1 WhatsApp (`com.whatsapp`) + 1 WABA (`com.whatsapp.w4b`)
- Total máximo: 8 números por device
- WABA ainda não configurado

### 6. senderNumber obrigatório no POST /messages
- Quem decide o número é o plugin (Oralsin), não o core
- Dispatch roteia pro device/profile que tem aquele número
- Dequeue filtra: `WHERE sender_number IN (números deste device)`
- Se nenhum device online tem o sender_number → mensagem fica `queued`

### 7. Lógica de distribuição é dos plugins, não do core
- Core é agnóstico — roteia pelo número
- Oralsin tem: batches por clínica, número principal + backup, backup global
- Contato "adotado" por um número (sempre recebe do mesmo)

### 8. Alert lifecycle: Auto-resolve com histórico
- Health poll detecta métrica volta ao normal → resolve automaticamente
- Histórico mantido no SQLite pra investigação pós-incidente

### 9. Profile switching: Sequencial (Phase 2) / MUMD (Phase 8)
- Phase 2: `am switch-user N`, batch por profile antes de trocar
- Phase 8: Investigar MUMD (config_multiuserVisibleBackgroundUsers) com root + Magisk
- Paralelismo REAL vem de múltiplos devices físicos

## Decisões Confirmadas (continuação)

### 10. Alert thresholds: Global defaults + per-device override
Config global em `dispatch.config.json`, override per-device via coluna `alert_thresholds` (JSON nullable) na tabela `devices`. NULL = usa global.

| Métrica | Threshold | Severity |
|---------|-----------|----------|
| Battery | < 15% | high |
| Battery | < 5% | critical |
| RAM available | < 200MB | high |
| Temperature | > 40°C | high |
| Temperature | > 45°C | critical |
| Storage free | < 500MB | medium |
| Device offline | > 30s | high |
| WA crash detected | — | critical |

### 11. Device actions: Send-lock guard + confirmação UI
- **Screenshot**: sempre permitido (non-destructive)
- **Reboot / Restart WA**: bloqueado se `send_phase != null` (device enviando) + confirmação "Você tem certeza?" na UI
- Guard reutiliza o campo `send_phase` do worker (decisão #2) — zero overhead

### 12. UI hierarchy: 3 níveis, Phase 2 implementa 1-2
Escala futura: 20 devices × 4 profiles × 2 apps = 160 slots. Grid plano inviável.

**Hierarquia:**
```
Device (hardware: bateria, RAM, temp, storage)
  └─ Profile (Android user 0, 10, 11, 12)
       └─ Account (com.whatsapp / com.whatsapp.w4b → número)
```

**Phase 2 scope (1-2 devices, 4 users cada):**
- **Nível 1 — Device Grid**: cards compactos em grid responsivo. Badge status (online/offline/sending), bateria %, ícone alerta.
- **Nível 2 — Device Detail**: painel lateral no click. Health completo (RAM, temp, storage, WiFi), spark charts 24h, lista profiles → accounts → números.
- **Alert Panel**: lista global alertas ativos/resolvidos, filtro por device, severity badge.
- **Spark charts**: inline no detail panel (não no card — card é compacto).
- **Nível 3 — Account Detail**: diferido para Phase 6.

## Pesquisa MUMD (referência para Phase 8)

### Testado no POCO Serenity (Android 15, Unisoc UMS9230):
- `Supports visible background users on displays: false`
- scrcpy `--new-display` cria virtual displays funcionais
- Apps do user 0 rodam em virtual displays ✅
- Input independente por display (`input -d N`) ✅
- Background users NÃO renderizam UI ❌ (flag desabilitado)
- `cmd overlay fabricate` habilita o flag mas requer root
- `fastboot boot` desabilitado no Unisoc UMS9230
- Sem CVE para temporary root sem wipe neste chipset
- Caminho: bootloader unlock → Magisk → `cmd overlay fabricate --target android --name DispatchMUMD android:bool/config_multiuserVisibleBackgroundUsers 0x12 0xffffffff`

## Profile Map (device backup)

| User | Profile Name   | WA Number          | Google Account          |
|------|---------------|--------------------|-----------------------|
| 0    | Main Oralsin 2 | +55 43 9683-5100  | oralsinmain0@gmail.com |
| 10   | Oralsin 2 1   | +55 43 9683-5095  | oralsin35@gmail.com    |
| 11   | Oralsin 2 2   | +55 43 9683-7813  | o59281705@gmail.com    |
| 12   | Oralsin 2 3   | +55 43 9683-7844  | oralsin960@gmail.com   |

PIN: 12345 (todos profiles)
Device: 9b01005930533036340030832250ac (POCO 25028PC03G, Android 15, Unisoc UMS9230)
