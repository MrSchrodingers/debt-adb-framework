# Pesquisa Consolidada: Throughput, Paralelismo, Seguranca e Anti-Ban

> **Data**: 2026-04-08
> **Fontes**: 4 agentes de pesquisa + 16 testes no device fisico
> **Device**: POCO C71 (Android 15, MT6765V, 4GB RAM, root)

---

## 1. Status Atual (Implementado)

| Metrica | Valor |
|---------|-------|
| Throughput por sender | ~190 msgs/hora |
| Throughput 4 senders | ~760 msgs/hora |
| Tempo por mensagem | ~19s (12s envio + 7s jitter) |
| Metodo de input | wa.me?text= pre-fill (zero typing) |
| 462 testes passando | 42 arquivos |

---

## 2. Tecnicas Testadas no Device — Resultado

### FUNCIONAM (confirmado):

| Tecnica | Teste | Resultado | Impacto |
|---------|-------|-----------|---------|
| **wa.me?text= pre-fill** | T14 | Msg enviada, zero typing | Elimina typing |
| **Scrcpy virtual display** | T12-T16 | WA abre, UIAutomator funciona, msg enviada | **2x paralelo** |
| **input -d N** (display routing) | T1, T15 | Input vai pro display correto | Habilitador |
| **uiautomator --display N** | T13 | UI capturada do virtual display | Habilitador |
| **On-device script** | T6 | 6.2s por envio em 1 ADB call | -30% overhead |
| **Clipboard paste** | T5 | 200ms qualquer tamanho | Fallback |
| **Batch shell commands** | T4b | 3 cmds em 1 call | -200ms/batch |

### NAO FUNCIONAM:

| Tecnica | Teste | Motivo |
|---------|-------|--------|
| `am start --display N` para WA | T2, T3 | Android security policy |
| Monkey server | T8 | Crash (tombstone) |
| sendevent mais rapido que input | T4b | su -c overhead |
| WA paralelo MESMO user | T16 | Single-instance migra |
| Overlay displays estaveis | T10 | Desaparecem |
| Direct DB manipulation | Pesquisa | Signal Protocol impede |
| Frida hooks em WA | Pesquisa | WA detecta Frida |

---

## 3. Fingerprints de Automacao — Risco Real

### O que WhatsApp REALMENTE detecta (server-side ML):

| Sinal | Risco | Nosso Status |
|-------|-------|-------------|
| **Volume** (>200/dia/numero) | ALTO | 4-8 senders mitiga |
| **Conteudo similar** (template) | ALTO | Msgs personalizadas por paciente |
| **Timing patterns** (inter-msg uniforme) | MEDIO | Jitter aleatorio implementado |
| **Typing indicator ausente** | MEDIO | wa.me?text= NAO gera "digitando..." |
| **Trafego unidirecional** (so envia, nunca recebe) | MEDIO | Pacientes respondem organicamente |
| **Contato criado + msg imediata** | BAIXO | ensureContact ja implementado |
| **Reclamacoes de destinatarios** | CRITICO | Fora do controle |

### O que WhatsApp NAO detecta (client-side):

| Sinal | Evidencia |
|-------|-----------|
| ADB connection | WA nao checa isDebuggerConnected() |
| input text/tap via InputManager | Mesma API que teclado fisico |
| wa.me?text= deep link | API oficial documentada |
| UIAutomator dump | Accessibility generico |
| USB debugging | WA nao verifica |
| screencap | Screen recording detection NAO detecta |

### Fingerprint CRITICO descoberto: Typing Indicator

O **wa.me?text= pre-fill NAO gera "digitando..."** para o destinatario. Em envio manual, o indicador "digitando..." aparece enquanto a pessoa digita. No pre-fill, o texto aparece instantaneamente.

**Mitigacao**: Este eh um sinal FRACO porque:
1. Muitas pessoas copiam/colam mensagens (mesmo comportamento)
2. Links compartilhados via share intent tambem nao geram indicador
3. WhatsApp nao usa APENAS este sinal — eh parte de um conjunto

---

## 4. Descoberta: uinput Virtual Keyboard (Pesquisa CVE)

O agente de CVE/hardware encontrou que `/dev/uinput` permite criar um **teclado virtual que eh indistinguivel de hardware real**:

- Eventos passam pelo pipeline completo: `EventHub → InputReader → InputDispatcher`
- **Sem flag POLICY_FLAG_INJECTED** (que `input text` tem)
- **Device ID real** (nao VIRTUAL_KEYBOARD_ID = -1)
- Se configurado com `BUS_USB` e vendor/product do touchscreen real, eh **identico a hardware**

**Implicacao**: Se implementarmos uinput, os eventos de toque e digitacao seriam absolutamente indistinguiveis de um humano usando o celular. Isso eh mais robusto que `input tap` (que usa injectInputEvent com flag de injecao).

**Complexidade**: ~200 linhas de C. Compilar como binario nativo, push para device.
**Prioridade**: MEDIO — `input tap` funciona e WA nao checa source. uinput seria defense-in-depth.

---

## 5. Accessibility Service (dispatchGesture) — Descoberta Bonus

O agente de CVE descobriu que `AccessibilityService.dispatchGesture()` sintetiza toques que o sistema trata **identicamente a toques reais**:
- Sem `POLICY_FLAG_INJECTED`
- Sem `VIRTUAL_KEYBOARD_ID`
- Nao bloqueado por `filterTouchesWhenObscured`
- **Nao requer root**

**Implicacao**: Instalar um APK de AccessibilityService customizado seria o metodo mais limpo. Porem, requer manter o service ativo e registrado — adiciona complexidade operacional.

---

## 6. Root Hiding Stack (RECOMENDADO)

Para proteger contra deteccao de root pelo WhatsApp (Play Integrity):

| Componente | Funcao |
|-----------|--------|
| **Magisk v27+** | Root manager |
| **Zygisk-Assistant** | Hide Zygisk de apps (substituiu Shamiko) |
| **PlayIntegrityFork v16** | Spoof attestation |
| **BootloaderSpoofer** | Google maio 2025: bootloader unlocked = fail |
| **HMA-OSS** | Hide Magisk App |
| **LSPosed** | Hook framework (opcional) |

**Prioridade**: ALTA para producao. WA nao bane por root sozinho, mas Play Integrity fail pode restringir features futuras.

---

## 7. Projecao de Throughput por Configuracao

### Config A: Atual (1 worker sequencial, 4 senders)
```
~190 msgs/h per sender × 4 = ~760 msgs/h
500 msgs: ~40 min | 1000 msgs: ~1h20 | 2000 msgs: ~2h40
```

### Config B: On-device script (1 worker, menor overhead)
```
~580 msgs/h per sender × 1 (sequencial) = ~580 msgs/h
Mas com 4 senders e batching otimizado: ~1160 msgs/h
500 msgs: ~26 min | 1000 msgs: ~52 min
```

### Config C: Scrcpy paralelo (2 workers, 2 users em 2 displays)
```
2 × ~760 msgs/h = ~1520 msgs/h
500 msgs: ~20 min | 1000 msgs: ~40 min | 2000 msgs: ~1h20
```

### Config D: On-device script + paralelo (2 workers)
```
2 × ~1160 msgs/h = ~2320 msgs/h
500 msgs: ~13 min | 1000 msgs: ~26 min | 2000 msgs: ~52 min
```

### Config E: 2 devices (4 workers, 8 senders)
```
4 × ~760 msgs/h = ~3040 msgs/h
1000 msgs: ~20 min | 5000 msgs: ~1h40
```

---

## 8. Roadmap de Implementacao (Priorizado por ROI)

### Fase 1 — Ja implementado:
- [x] wa.me?text= pre-fill
- [x] Batch-aware send (skip force-stop)
- [x] Batch shell commands
- [x] ADB shell timeout (30s)
- [x] Phone format normalization
- [x] Partial batch enqueue
- [x] Callback retry cap (20/ciclo)

### Fase 2 — Proximo (1-2 semanas):
- [ ] On-device script (push + execute, 1 ADB call)
- [ ] Root hiding stack (Magisk + Zygisk + PIF + BootloaderSpoofer)
- [ ] WABA accounts (dobra senders para 8)
- [ ] Reducao de jitter para 3s (se <100/dia/numero)

### Fase 3 — Curto prazo (2-4 semanas):
- [ ] Worker multi-display via scrcpy (2 workers paralelos)
- [ ] User 10 no virtual display com WA independente
- [ ] Dispatcher round-robin entre workers
- [ ] Screenshot via scrcpy (fallback para screencap que nao funciona em VD)

### Fase 4 — Medio prazo (1-2 meses):
- [ ] uinput virtual keyboard (200 linhas C, defense-in-depth)
- [ ] Variar metodo de abertura de chat (wa.me 50%, search 30%, chat list 20%)
- [ ] Segundo POCO C71 (scaling linear)
- [ ] Ban detection + auto-quarantine integrado

### Fase 5 — Longo prazo:
- [ ] Accessibility Service bridge (zero fingerprint)
- [ ] Session simulation (navegar chats antes de enviar)
- [ ] Gradual volume ramp-up por conta nova
- [ ] Monitoring + alerting automatizado

---

## 9. CVEs Relevantes Encontradas

| CVE | Componente | CVSS | Relevancia |
|-----|-----------|------|-----------|
| CVE-2025-22438 | InputDispatcher UAF | 7.8 | Memory corruption, nao util (ja temos root) |
| CVE-2024-20069 | MediaTek video decoder | 6.7 | MT6765 afetado, sem impacto em input |
| CVE-2024-20063 | MediaTek modem | 8.1 | MT6765 afetado, sem impacto em display |

**Nenhuma CVE exploravel** para bypass de deteccao de input. O root ja fornece privilegio superior a qualquer CVE nessa area.

---

## 10. Conclusao

O throughput maximo por device com a implementacao atual eh **~760 msgs/hora** (4 senders). Com otimizacoes testadas e confirmadas, pode chegar a **~2320 msgs/hora** (on-device script + paralelo scrcpy).

O risco principal de ban NAO eh deteccao de automacao local — eh **padrao comportamental server-side**. O wa.me?text= pre-fill usa a API oficial do WhatsApp. O jitter inter-mensagem simula uso humano. A personalizacao por paciente evita template detection.

Para volume >2000 msgs/dia: segundo device eh a forma mais segura e confiavel de escalar.
