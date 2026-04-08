# Pesquisa: Throughput, Paralelismo e Anti-Fingerprint — Dispatch ADB

> **Data**: 2026-04-08
> **Device**: POCO C71 (Android 15, MediaTek Helio G36, 4GB RAM, root)
> **Metodo**: 4 agentes de pesquisa paralelos + testes praticos no device

---

## 1. Throughput Medido (antes vs depois)

| Etapa | Per msg | Throughput (1 sender) | 4 senders | 8 senders |
|-------|---------|----------------------|-----------|-----------|
| Baseline (char-by-char) | 31s | 116/h | 464/h | — |
| Word-chunk typing | 20s | 180/h | 720/h | — |
| **wa.me?text= pre-fill** | **12s real + 7s jitter = 19s** | **190/h** | **760/h** | **1520/h** |

### Breakdown do tempo por mensagem (2a+ no batch):

```
BACK to exit chat       0.5s   (era 5.3s com force-stop)
am start wa.me?text=    2.0s   (msg pre-preenchida, zero typing)
waitForChatReady        2.0s   (UIAutomator dump + check)
tapSendButton           2.0s   (dump + tap)
screenshot              2.0s   (screencap + save)
jitter anti-ban         5-10s  (configuravel via INTER_MESSAGE_DELAY_MS)
────────────────────────────────
TOTAL                  ~14-19s
OVERHEAD FIXO          ~8.5s   (sem jitter)
```

### O que NAO pode ser reduzido:
- `am start` leva ~2s (startup do Intent + Chrome Custom Tab resolver)
- UIAutomator dump leva ~1-3s (Java process via Zygote)
- `screencap` leva ~2s (framebuffer capture)

---

## 2. wa.me?text= Pre-Fill (IMPLEMENTADO)

**Status: IMPLEMENTADO e TESTADO**

A descoberta chave: o deep link `https://wa.me/{phone}?text={encoded}` pre-preenche o campo de texto do WhatsApp. Elimina 100% da digitacao.

- **Fingerprint risk**: ZERO — eh a API oficial documentada do WhatsApp
- **Limite**: URL ~2KB. Mensagens >~1500 chars fazem fallback para typing em chunks
- **Resultado medido**: 4 msgs reais enviadas, todas com pre-fill, ~20s por msg

---

## 3. Paralelizacao — Analise Completa

### 3.1 Virtual Display (overlay_display_devices)

**Testado no POCO C71:**
```
settings put global overlay_display_devices "720x1280/160"
→ mDisplayId=2 criado com sucesso
```

**Problema**: `am start --display 2 -p com.whatsapp` eh bloqueado pelo Android 10+ security policy. Apps de terceiros nao podem iniciar activities em displays que nao criaram. Root pode bypass via:
- `appops set com.whatsapp SYSTEM_ALERT_WINDOW allow`
- Ou Xposed hook no ActivityTaskManagerService

**Veredicto**: Possivel com root + hooks, mas fragil. Nao recomendado para producao.

### 3.2 Scrcpy `--new-display` (MAIS PROMISSOR)

Scrcpy 3.0+ cria virtual displays reais via `DisplayManager.createVirtualDisplay()`. O server roda via `app_process` com privilegios de shell.

```bash
scrcpy --new-display=720x1280/160 --start-app=com.whatsapp
```

- `input -d <displayId>` roteia input para o display especifico
- Cada display pode hospedar WhatsApp de um user diferente
- **Limitacao RAM**: cada WhatsApp ~300MB. POCO 4GB = max 2 instancias paralelas

**Veredicto**: Viavel para 2x throughput. Requer supervisor process para manter scrcpy vivo.

### 3.3 Multi-User Simultaneo (MUMD)

`config_multiuserVisibleBackgroundUsers` eh **false** em todos os devices nao-automotivos. Background users tem apps suspensas.

**Veredicto**: Bloqueado sem custom firmware. Nao viavel no POCO C71.

### 3.4 Multi-Device (RECOMENDADO)

Segundo POCO C71 conectado via USB hub.
- Linear scaling garantido
- Zero risco tecnico
- Cada device com 4 senders = 8 senders total

**Veredicto**: Melhor ROI. 2 devices = 2x throughput, 100% confiavel.

---

## 4. Fingerprints de Automacao — Analise Completa

### O que o WhatsApp DETECTA:

| Sinal | Deteccao | Nosso Status |
|-------|----------|-------------|
| Volume de msgs (>200/dia/numero) | SIM (principal trigger) | Jitter mitiga |
| Msgs similares para muitos destinatarios | SIM (template detection) | Msgs sao personalizadas (nome paciente) |
| Reclamacoes de destinatarios ("spam") | SIM (causa #1 de ban) | Fora do controle |
| Conta nova enviando muito | SIM (age-based throttle) | Contas antigas (oralsin_2_*) |
| Multiplas contas no mesmo IP | PARCIAL (rate limiting) | 4 contas mesmo device, ok |

### O que o WhatsApp NAO DETECTA:

| Sinal | Por que nao detecta |
|-------|-------------------|
| `input text` via ADB | Usa InputManager.injectInputEvent(), mesma API que teclado fisico |
| `wa.me?text=` pre-fill | API oficial documentada do WhatsApp |
| Clipboard paste | Acao normal de usuario |
| Root/Magisk | WA checa Play Integrity mas nao bane por root sozinho |
| USB debugging ativo | WA nao verifica |
| UIAutomator dump | Accessibility service generico, nao relacionado a WA |
| `sendevent` (kernel-level input) | Injetado abaixo do framework, invisivel para apps |

### O que PODEMOS fazer para reduzir fingerprints:

1. **Magisk + Shamiko**: esconder root do WhatsApp (precaucao)
2. **Variar mensagens**: templates diferentes por clinica/paciente (ja feito pelo Oralsin)
3. **Jitter entre mensagens**: 5-10s aleatorio (implementado)
4. **Nao enviar >100/dia por numero**: dividir entre 8 senders = 25 cada
5. **Contatos registrados antes do envio**: `ensureContact` (implementado)

---

## 5. Tecnicas de Aceleracao Testadas

### 5.1 Batch shell commands (IMPLEMENTADO)

```bash
# Antes: 3 round-trips
adb shell input keyevent KEYCODE_WAKEUP
adb shell input swipe 540 1800 540 800 300
adb shell input keyevent 3

# Depois: 1 round-trip
adb shell "input keyevent KEYCODE_WAKEUP && sleep 0.3 && input swipe 540 1800 540 800 300"
```
Economia: ~200ms por batch de comandos.

### 5.2 Clipboard paste (TESTADO, fallback)

```bash
adb shell am broadcast -a clipper.set -e text "mensagem completa"
adb shell input keyevent 279  # PASTE
```
Tempo: ~200ms para qualquer tamanho de mensagem. Requer Clipper app instalado.

### 5.3 Monkey server (NAO IMPLEMENTADO, futuro)

adbkit tem `openMonkey()` built-in. Conexao TCP persistente para taps/keys, sem spawn de processo Java por comando.
Economia estimada: ~100ms por tap (de 200ms para 100ms).

### 5.4 On-device shell script (NAO IMPLEMENTADO, futuro)

Push script para `/data/local/tmp/`, executa localmente. Elimina round-trips ADB para sequencias complexas.

---

## 6. Projecao de Capacidade

### Config atual (1 POCO C71, 4 WA accounts):

| Volume diario | Tempo | Viavel? |
|---------------|-------|---------|
| 100 msgs | ~22 min | SIM |
| 200 msgs | ~44 min | SIM |
| 500 msgs | ~1h50 | SIM |
| 1000 msgs | ~3h40 | APERTADO (janela matinal) |

### Com 8 accounts (4 WA + 4 WABA):

| Volume diario | Tempo | Viavel? |
|---------------|-------|---------|
| 200 msgs | ~22 min | SIM |
| 500 msgs | ~55 min | SIM |
| 1000 msgs | ~1h50 | SIM |
| 2000 msgs | ~3h40 | APERTADO |

### Com 2 devices (8 WA + 8 WABA = 16 senders):

| Volume diario | Tempo | Viavel? |
|---------------|-------|---------|
| 500 msgs | ~28 min | SIM |
| 1000 msgs | ~55 min | SIM |
| 2000 msgs | ~1h50 | SIM |
| 5000 msgs | ~4h35 | APERTADO |

---

## 7. Recomendacao de Roadmap

### Fase 1 — Agora (implementado):
- wa.me?text= pre-fill ✓
- Batch-aware send (skip force-stop) ✓
- Batch shell commands ✓
- Inter-message jitter configuravel ✓

### Fase 2 — Curto prazo (1-2 semanas):
- Configurar 4 WABA accounts (dobra senders para 8)
- Instalar Magisk + Shamiko (esconder root)
- Reduzir jitter para 3s se <100 msgs/dia/numero

### Fase 3 — Medio prazo (1 mes):
- Segundo POCO C71 (2x throughput garantido)
- Monkey server para taps mais rapidos
- On-device script para reducao de round-trips

### Fase 4 — Escala (2-3 meses):
- Scrcpy virtual display (2x paralelo por device)
- Worker pool multi-device no Dispatch
- Monitoring + alerting de ban por numero
