# Estudo Completo do Dispositivo - POCO Serenity
## Data: 2026-04-01 13:23 BRT

---

## 1. IDENTIDADE DO DISPOSITIVO (adb-explore)

| Campo | Valor |
|-------|-------|
| Marca | POCO |
| Modelo | 25028PC03G |
| Device | serenity |
| Product | serenity_p_global |
| Android | 15 (SDK 35) |
| Build | A15.0.13.0.VGWMIXM |
| Security Patch | 2025-09-01 (7 meses atrasado) |
| Serial | 9b01005930533036340030832250ac |
| Fingerprint | POCO/serenity_p_global/serenity:15/AP3A.240905.015.A2/A15.0.13.0.VGWMIXM:user/release-keys |

### Perfis de Usuario (4 ativos, 8 WhatsApps)
| ID | Nome | Status | WhatsApp | WA Business |
|----|------|--------|----------|-------------|
| 0 | Main Oralsin 2 | running | Sim | Sim |
| 10 | Oralsin 2 | running | Sim | Sim |
| 11 | Oralsin 2 2 | parado | Sim | Sim |
| 12 | Oralsin 2 3 | running | Sim | Sim |

---

## 2. HARDWARE (adb-explore)

### CPU
| Campo | Valor |
|-------|-------|
| Chipset | Unisoc UMS9230 (T615) |
| Arquitetura | arm64-v8a (ARMv8) |
| Cores | 8 (6x Cortex-A55 @ 1.6GHz + 2x Cortex-A75 @ 1.8GHz) |
| CPU0-5 (efficiency) | 614 MHz atual / 1612 MHz max |
| CPU6 (performance) | 1228 MHz atual / 1820 MHz max |
| CPU7 (performance) | 1820 MHz atual / 1820 MHz max |

### Memoria
| Campo | Valor | Status |
|-------|-------|--------|
| RAM Total | 2,855 MB | Budget tier |
| RAM Disponivel | 1,425 MB (50%) | OK |
| RAM Livre | 300 MB | Baixo |
| Swap Total | 3,072 MB | Ativo (bom) |
| Swap Usado | 1,233 MB (40%) | Normal |
| Swap Livre | 1,877 MB | OK |

### Tela
| Campo | Valor |
|-------|-------|
| Resolucao | 720 x 1640 (HD+) |
| Densidade | 320 dpi |

### Temperatura
| Sensor | Temp (C) | Status |
|--------|----------|--------|
| Bateria | 24.0 - 24.9 | Normal |
| SoC | 24.0 - 25.1 | Normal |
| GPU | 24.0 - 24.1 | Normal |
| Skin | 29.0 - 29.4 | Normal |
| PA (power amp) | 28.0 - 28.3 | Normal |

---

## 3. ARMAZENAMENTO (adb-explore)

| Campo | Valor |
|-------|-------|
| Total | 50 GB |
| Usado | 12 GB (24%) |
| Livre | 38 GB (76%) |
| Encriptacao | File-based Encryption (ativo) |
| Disk Write Speed | 18,539 KB/s |
| Latencia | 2ms |
| App Size (total) | 3.4 GB |
| App Data | 1.1 GB |
| App Cache | 90 MB |
| Fotos | 454 KB |
| Videos | 14 MB |

---

## 4. BATERIA (adb-explore)

| Campo | Valor |
|-------|-------|
| Nivel | 100% |
| Status | Completa (status 5) |
| Saude | Boa (health 2) |
| Temperatura | 24.8 C |
| Tensao | 4.408V |
| Tecnologia | Li-poly |
| Fonte | USB powered |
| Corrente max | 500mA (carregamento lento/USB 2.0) |

---

## 5. REDE (adb-explore)

| Campo | Valor |
|-------|-------|
| WiFi SSID | AMARAL COLABORADORES |
| WiFi Standard | 802.11ac (WiFi 5) |
| Frequencia | 5200 MHz (banda 5GHz) |
| IP | 10.1.2.37/16 |
| TX Speed | 90 Mbps |
| RX Speed | 120 Mbps |
| Max Speed | 200 Mbps |
| RSSI | -71 dBm (fraco, limite aceitavel) |
| Seguranca WiFi | WPA2-PSK |
| DNS | 10.1.1.7, 8.8.8.8, 8.8.4.4 |
| Dominio | PEDRIVASCO.LOCAL |
| Gateway | 10.1.1.1 |
| Conexao ativa | 10.1.2.37:40666 -> 108.177.123.188:5228 (Google FCM/Push) |

---

## 6. AUDITORIA DE SEGURANCA (adb-security)

### Postura de Seguranca
| Check | Valor | Veredicto |
|-------|-------|-----------|
| Encryption | encrypted (file-based) | OK |
| SELinux | Enforcing | OK |
| Verified Boot | green | OK |
| Bootloader | Locked (1) | OK |
| USB Debugging | ATIVO (1) | MEDIO - desativar quando nao usar |
| Unknown Sources | ATIVO (1) | MEDIO - permite sideload de APKs |
| Developer Options | ATIVO (1) | MEDIO - dev mode ativo |
| Private DNS | NULL (desativado) | ALTO - sem DNS criptografado/ad-blocking |
| HTTP Proxy | null | OK |
| ADB over TCP | desativado | OK |
| Security Patch | 2025-09-01 | ALTO - 7 meses desatualizado |

### Permissoes Perigosas
Nenhum app de terceiro com permissoes perigosas criticas detectado.
Apps com permissoes sao todos de sistema (WhatsApp, Camera, Phone).

### Device Admin
Nenhum Device Admin configurado em nenhum perfil. OK.

### Accessibility Services
Nenhum servico de acessibilidade ativado. OK.

### Notification Listeners
`com.gogo.launcher/NotificationListener` - O launcher le todas as notificacoes
para exibir badges. Normal para launchers.

### Apps Sideloaded (fora da Play Store)
| App | Installer |
|-----|-----------|
| com.miui.calculator.go | null (pre-instalado OEM) |
| com.android.calendar.go | null (pre-instalado OEM) |

Nenhum app suspeito sideloaded detectado.

### Network Exposure
- Nenhuma porta TCP aberta (LISTEN)
- Sem proxy configurado
- Sem VPN ativa
- Unica conexao ESTABLISHED: Google FCM (push notifications)
- ADB apenas via USB (nao TCP)

### Veredicto de Seguranca

| Severidade | Findings |
|------------|----------|
| CRITICO | Nenhum |
| ALTO | Security patch 7 meses atrasado; Private DNS desativado |
| MEDIO | USB debugging ativo; Unknown sources ativo; Dev options ativo |
| BAIXO | Nenhum |
| INFO | Launcher tem notification listener (esperado) |

### Recomendacoes
1. **Atualizar security patch** - 2025-09-01 esta 7 meses desatualizado
2. **Ativar Private DNS** - Usar `dns.adguard-dns.com` para criptografia + ad-blocking
3. **Desativar USB debugging** quando nao estiver usando ADB
4. **Desativar Unknown Sources** para prevenir instalacao de APKs maliciosos

---

## 7. WHATSAPP (adb-whatsapp)

### Versoes
| App | Versao |
|-----|--------|
| WhatsApp | 2.26.11.73 |
| WhatsApp Business | 2.26.12.72 |

### Presenca por Perfil
Todos os 4 perfis (0, 10, 11, 12) tem WhatsApp + WhatsApp Business instalados.
Total: 8 instancias de WhatsApp.

### Processos Ativos
- `com.whatsapp` no user 0 (principal) - PID 8943, 139MB RAM
- `com.whatsapp` no user 12 - 156MB RAM
- Services: GcmFGService (push), MessageService (x3 profiles)

### Storage
| Item | Tamanho |
|------|---------|
| Media WhatsApp | 15 MB |
| Media WA Business | 234 KB |

Uso de storage muito baixo — aparelho relativamente novo ou pouco media.

---

## 8. PERFORMANCE (adb-performance)

### CPU Load
Load average: 11.39 11.54 11.06 (altissimo para 8 cores)
Idle: 783% de 800% = 97.9% idle real

### Top Consumidores de RAM (MB)
| Processo | RAM | Perfil |
|----------|-----|--------|
| system | 275 MB | core |
| SystemUI | 222 MB | core |
| Google Play Services | 213 MB | user 10 |
| Google Play Services | 192 MB | user 12 |
| GMS persistent | 171 MB | user 0 |
| GMS persistent | 161 MB | user 10 |
| WhatsApp | 157 MB | user 12 |
| GMS persistent | 152 MB | user 12 |
| WhatsApp | 148 MB | user 0 |
| Play Store bg | 117 MB | user 12 |
| Play Store bg | 110 MB | user 10 |
| Gboard | 105 MB | user 10 |
| Gboard | 101 MB | user 0 |
| Settings | 96 MB | user 0 |
| Launcher | 88 MB | user 0 |

**Google Play Services consome ~680 MB** (3 instancias persistent + 2 gms = 5 processos).
Sozinho ocupa 24% da RAM total.

### Processos em Execucao: 33
Distribuicao por categoria:
- Google (GMS/Play/Ext): 11 processos
- Android core: 10 processos
- WhatsApp: 2 processos
- System services: 6 processos
- Launcher: 1 processo
- Misc (Bluetooth, WiFi, IMS): 3 processos

### Animacoes
| Setting | Valor |
|---------|-------|
| Window | 1.0x (padrao) |
| Transition | 1.0x (padrao) |
| Animator | null (padrao) |

### Background Process Limit
null (sem limite) - com 2.7GB RAM e 4 perfis, deveria ter limite.

---

## 9. SPAM & NOTIFICACOES (adb-spam-cleanup)

### Notificacoes Ativas
| Count | App | Status |
|-------|-----|--------|
| 20 | WhatsApp | Esperado (mensagens) |
| 8 | Contatos | Badges normais |
| 6 | Android System | Sistema |
| 5 | Google Play Services | Push/sync |

**Pos-limpeza: ZERO spam.** Antes havia 21 notificacoes do MiPicks e 16 do Messages.

### Ad-Blocking
| Item | Status |
|------|--------|
| Private DNS | DESATIVADO |
| DND Mode | OFF (0) |

Recomendacao: ativar Private DNS com `dns.adguard-dns.com`.

---

## 10. OBSERVACOES DO SCREENSHOT

A tela de bloqueio mostra:
- 13:23, 1 de abril
- Operadora: TIM | TIM (dual SIM)
- WhatsApp: **332 mensagens de 8 conversas** (4 nao lidas)
- WhatsApp push: "Registre cada emocao com..."
- Chamada perdida: 04321052486 (1d atras)
- Notificacao USB debugging ativa
- Bateria: 100%, carregando

---

## 11. SUMARIO EXECUTIVO

### Pontos Positivos
- Device encriptado, bootloader locked, SELinux enforcing, verified boot green
- Bloatware removido com sucesso (40 apps, zero spam)
- Storage saudavel (76% livre)
- Temperatura normal em todos os sensores
- Nenhum app suspeito ou sideloaded
- Sem device admins maliciosos
- Sem ports expostos na rede

### Pontos de Atencao
| Prioridade | Issue | Acao |
|------------|-------|------|
| ALTA | Security patch 7 meses atrasado | Atualizar MIUI/HyperOS |
| ALTA | Private DNS desativado | `adb shell settings put global private_dns_mode hostname && adb shell settings put global private_dns_specifier dns.adguard-dns.com` |
| MEDIA | USB debug ativo | Desativar quando nao usar ADB |
| MEDIA | Unknown sources ativo | Desativar para seguranca |
| MEDIA | GMS consome 680MB (24% RAM) | Inevitavel com 3 perfis ativos |
| MEDIA | Animacoes em 1.0x | Reduzir para 0.5x para melhor fluidez |
| MEDIA | Sem limite de processos bg | Definir limite de 2-3 |
| BAIXA | WiFi RSSI -71 dBm | Sinal fraco, considerar posicao do AP |
| BAIXA | Carregamento USB lento (500mA) | Usar carregador de parede para carga rapida |
