# Resultados dos Testes — Paralelismo e Performance

> **Data**: 2026-04-08
> **Device**: POCO C71 (Android 15, root, scrcpy 3.3.4)
> **16 testes executados no device fisico**

---

## Resumo dos Testes

| Teste | O que testou | Resultado | Viavel? |
|-------|-------------|-----------|---------|
| **T1** | Virtual display overlay | Display 3 criado, input -d funciona | SIM |
| **T2** | WhatsApp no overlay display | Cai no display 0 (security policy) | NAO |
| **T3A** | SYSTEM_ALERT_WINDOW grant | Ainda cai no d0 | NAO |
| **T3B** | Freeform + display 3 | Aparece em d9 (display diferente!) | PARCIAL |
| **T3C** | Move task to display | `am task set-display` nao existe | NAO |
| **T4** | sendevent vs input tap timing | input tap (76ms) >> sendevent (456ms) | input MELHOR |
| **T5** | Clipboard paste | 200ms para qualquer tamanho | SIM |
| **T6** | On-device script | 6.2s para envio completo (1 ADB call) | SIM |
| **T7** | Scrcpy version check | v3.3.4 instalado | OK |
| **T8** | Monkey server | Crashed (tombstone) | NAO |
| **T10** | Parallel input -d | Overlay displays desapareceram | INSTAVEL |
| **T12** | Scrcpy --new-display | Display criado com sucesso (id=4,5,6,7,8) | SIM |
| **T13** | WA no scrcpy display + UIAutomator | Entry + send button encontrados! | SIM |
| **T14** | **ENVIO do virtual display** | **MENSAGEM ENVIADA COM SUCESSO** | **SIM** |
| **T15** | **2 displays simultaneos** | Ambos com entry+send, parallel tap 104ms | **SIM** |
| **T16** | **Parallel send real** | D8 confirmado, D0 migrou (single instance) | **PARCIAL** |

---

## Descobertas Criticas

### 1. Scrcpy Virtual Display FUNCIONA para WhatsApp
- `scrcpy --new-display=720x1280/160 --start-app=com.whatsapp` cria display e abre WA
- `uiautomator dump --display N` captura a UI do virtual display
- `input -d N tap/text/keyevent` envia input para o virtual display
- **Mensagens sao realmente enviadas** (confirmado no chat)

### 2. WhatsApp eh Single-Instance por User
- Mesmo user nao pode ter 2 instancias WA em 2 displays diferentes
- O segundo `am start` MIGRA a activity, nao cria nova
- **Para parallelismo real**: cada display precisa de um USER diferente

### 3. `input tap` eh mais rapido que `sendevent`
- `input tap`: 76ms (framework-level, Java process via Zygote)
- `sendevent` via `su -c`: 456ms (overhead do root shell)
- **Contra-intuitivo**: o metodo high-level eh mais rapido por causa do overhead do su

### 4. On-Device Script reduz para 1 ADB call
- Push script para `/data/local/tmp/`, executa localmente
- Envio completo (open + wait + send) em **6.2s** em 1 chamada
- Elimina todos os round-trips ADB exceto o primeiro

### 5. Clipboard Paste funciona (200ms)
- `am broadcast -a clipper.set -e text "..."` + `input keyevent 279`
- Qualquer tamanho de mensagem em ~200ms
- Requer Clipper app instalado

### 6. Monkey Server CRASHOU
- `monkey --port 1080` gerou tombstone (NativeCrash)
- Nao viavel neste device/Android version

---

## Cenario de Parallelismo Viavel

```
POCO C71 (1 device, 4GB RAM)
├── Display 0 (fisico): User 0 + WhatsApp → Worker A
├── Display N (scrcpy): User 10 + WhatsApp → Worker B
│
├── Worker A: input tap/text no display 0
├── Worker B: input -d N tap/text no display N
│
└── Throughput: 2x (paralelo real, users diferentes)
```

### Pre-requisitos:
1. User 10 precisa estar INICIADO (`am start-user 10`)
2. WhatsApp instalado e registrado no user 10
3. Scrcpy cria virtual display e inicia WA do user 10 nele
4. `input -d N` roteia para o display do user 10

### Limitacao de RAM:
- WhatsApp: ~300MB por instancia
- Scrcpy server: ~50MB
- Android system: ~1.5GB
- **Livre para 2 instancias**: ~2GB usados, ~2GB restantes
- **3a instancia**: provavelmente causa OOM ou swap intenso

---

## Timings Medidos (resumo)

| Operacao | Tempo |
|----------|-------|
| `input tap` | 76ms |
| `input text 'word'` | 109ms |
| `input keyevent` | 141ms |
| `am start wa.me` | 96ms |
| `sendevent` batch (su -c) | 456ms |
| `am broadcast clipper.set` | ~100ms |
| `uiautomator dump` | 1-3s |
| `screencap` | ~2s |
| On-device script (full send) | 6.2s |
| wa.me?text= pre-fill + tap send | 3.2s (sem wait) |
