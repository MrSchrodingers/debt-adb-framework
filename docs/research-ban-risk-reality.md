# Risco Real de Ban — Analise Baseada em Evidencias

> **Data**: 2026-04-08
> **Fontes**: Log do device, strings de libwhatsapp.so, 83 fontes web (GitHub issues, docs oficiais)

---

## Veredicto: A afirmacao "WhatsApp NAO detecta" era INCOMPLETA

### O que descobrimos no device:

1. **`entryPointSource=click_to_chat_link`** — WhatsApp LOGA cada abertura via wa.me. 29 entries hoje. Se enviarmos 200 msgs/dia, serao 200 entries de `click_to_chat_link` do mesmo device. Isso eh um padrao anomalo que vai ao servidor.

2. **`BizIntegritySignalsStore/getBusinessIntegritySignals`** — Chamado 28 vezes hoje (~1x por minuto quando ativo). Coleta e envia "sinais de integridade" ao servidor Meta. O conteudo exato eh opaco mas a frequencia indica monitoramento constante.

3. **`WAIntegrityPrepareSafeSignals(WASafeDetectionType)`** — Funcao nativa em libwhatsapp.so que prepara sinais de deteccao. Enum `WASafeDetectionType` sugere multiplos tipos de verificacao.

4. **Play Integrity** — `IntegrityManagerFactory`, `IntegrityTokenRequest` confirmados no binario. WhatsApp verifica integridade do device com Google.

### O que a pesquisa de campo encontrou (83 fontes):

#### Gatilhos CONFIRMADOS de ban:

| Gatilho | Volume para ban | Evidencia |
|---------|----------------|-----------|
| **Msgs para contatos nao salvos** | 15-20/dia = ban progressivo | Baileys #1983 |
| **Trafego unidirecional** (so envia) | Fator multiplicador | whatsmeow #199 |
| **Conteudo similar/template** | 3 msgs identicas/hora = flag | baileys-antiban |
| **Volume alto de numero novo** | 20 msgs/dia no dia 1 | GREEN-API warm-up |
| **IP de datacenter** | Fator multiplicador | Baileys #2309 |
| **Block + Report do destinatario** | 5-10 reports = review | Oficial WhatsApp |

#### Gatilho CRITICO para nosso caso: Reachout Timelock (Erro 463)

O WhatsApp tem um mecanismo chamado **Reachout Timelock** (Baileys #2441): cada msg para um contato novo consome um "token" de reachout. Sem `tctoken`/`cstoken` (que o client oficial gera), TODA mensagem eh tratada como "reachout". Default timelock: 60s entre msgs.

**wa.me?text= SEMPRE eh tratado como reachout** — mesmo para contatos salvos. O entryPoint `click_to_chat_link` eh categorizado diferente de abrir um chat pela lista de conversas.

#### O que NAO foi encontrado como gatilho:

| NAO detectado | Evidencia |
|---|---|
| ADB input text/tap | Zero relatos em 83 fontes |
| sendevent vs input | Nao ha mecanismo client-side |
| USB debugging | Nao verificado pelo WA |
| UIAutomator dump | Accessibility generico |
| Root (sem Play Integrity fail) | WA nao checa diretamente |

---

## Riscos Especificos do Dispatch

### ALTO RISCO:

| Risco | Nosso Cenario | Mitigacao |
|-------|--------------|-----------|
| **Msgs para nao-contatos** | Pacientes nao tem o numero salvo | `ensureContact` cria no device, mas no phone do paciente nao |
| **Trafego unidirecional** | Cobranca = 90% unidirecional | Pacientes respondem organicamente ~10-20% |
| **entryPointSource repetitivo** | 100% click_to_chat_link | **PRECISA VARIAR** — abrir via chat list ou search |
| **Conteudo template** | Msgs de cobranca sao similares | Oralsin personaliza por nome/valor |

### MEDIO RISCO:

| Risco | Nosso Cenario | Mitigacao |
|-------|--------------|-----------|
| **Volume por numero** | 50 msgs/dia/numero (4 senders) | Dentro do safe zone (50-100/dia) |
| **Play Integrity** | Device rooted | Precisa Magisk + PIF stack |
| **Typing indicator ausente** | wa.me?text= nao gera "digitando..." | Risco FRACO mas acumula |

### BAIXO RISCO:

| Risco | Nosso Cenario | Mitigacao |
|-------|--------------|-----------|
| ADB deteccao | Device fisico real | Nenhum relato de deteccao |
| IP | WiFi residencial | Nao eh datacenter |
| Device fingerprint | POCO real, nao emulador | Emulador = 3-5x mais ban |

---

## Recomendacoes Revisadas

### 1. VARIAR o metodo de abertura de chat (CRITICO)

Nao usar 100% wa.me?text=. Variar:
- **50% wa.me?text=** — pre-fill, rapido
- **30% chat list** — abrir WA, buscar contato na lista, tocar
- **20% search** — abrir WA, tocar na busca, digitar numero, tocar no resultado

Isso diversifica o `entryPointSource` e reduz o padrao anomalo.

### 2. Instalar root hiding stack (CRITICO)

- Magisk v27+ com Zygisk
- Zygisk-Assistant (hide root)
- PlayIntegrityFork v16
- BootloaderSpoofer
- DenyList: com.whatsapp + com.google.android.gms

### 3. Limites REAIS baseados em dados:

| Parametro | Limite Seguro | Nosso Config |
|-----------|--------------|-------------|
| Msgs/dia por numero | 50-100 | **50** (4 senders × 50 = 200) |
| Delay entre msgs | 15-40s | **19s** (12s envio + 7s jitter) ✓ |
| Msgs identicas/hora | Max 3 | Cada msg eh personalizada ✓ |
| Warm-up (numero novo) | 7 dias, 1.8x/dia | Contas existentes (oralsin_2_*) ✓ |
| Response ratio | >50% ideal | ~10-20% (risco) |

### 4. Nao confiar cegamente no pre-fill

O wa.me?text= eh OFICIAL e nao tem fingerprint de automacao, MAS:
- Gera `entryPointSource=click_to_chat_link` em TODAS as msgs
- Nao gera typing indicator
- Eh tratado como "reachout" (Reachout Timelock)

**Combinar com typing para msgs selecionadas** reduz o padrao.

---

## Conclusao

**A afirmacao "WhatsApp NAO detecta" era verdadeira no nivel LOCAL** (input events, ADB commands). Mas **INCOMPLETA no nivel SERVER-SIDE** (entryPointSource, BizIntegritySignals, Reachout Timelock).

O risco real nao eh a Meta detectar que usamos ADB. O risco real eh:
1. **200x `click_to_chat_link`/dia** = padrao anomalo
2. **Trafego unidirecional** = 90% envio, 10% resposta
3. **Contatos nao salvos no phone do paciente** = reachout rate alto
4. **Play Integrity failure** = restricao de funcionalidades

A implementacao tecnica (ADB, wa.me, input tap) eh segura. O problema eh **comportamental e de volume**.
