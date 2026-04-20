# ADB Tools

Toolkit para gerenciamento de smartphones Android via ADB (Android Debug Bridge).

## Estrutura

```
adb_tools/
├── scripts/                    # Scripts executaveis
│   ├── explore_device.sh       # Exploracao completa do dispositivo
│   ├── cleanup_bloatware.sh    # Remocao de bloatware (interativo/automatico)
│   ├── restore_bloatware.sh    # Restauracao de apps removidos
│   └── adb_utils.sh            # Utilidades gerais (screenshot, info, input, etc)
├── data/                       # Dados coletados do dispositivo
│   ├── device_info.txt         # Identidade e propriedades do dispositivo
│   ├── hardware_stats.txt      # CPU, RAM, storage, bateria
│   ├── all_packages_current.txt # Lista completa de pacotes
│   ├── system_packages.txt     # Pacotes de sistema
│   ├── user_packages.txt       # Pacotes do usuario (terceiros)
│   └── disabled_packages.txt   # Pacotes desativados
└── reports/                    # Relatorios e screenshots
    ├── cleanup_2026-04-01.md   # Relatorio da limpeza de bloatware
    ├── screenshot_before_cleanup.png
    └── screenshot_after_cleanup.png
```

## Dispositivo Registrado

| Campo | Valor |
|-------|-------|
| Marca | POCO (Xiaomi) |
| Modelo | 25028PC03G (serenity) |
| Android | 15 (SDK 35) |
| Chipset | Unisoc T615 (UMS9230) |
| RAM | 2.7 GB |
| Storage | 50 GB |
| Perfis | 4 (8 WhatsApps) |

## Uso Rapido

```bash
# Explorar dispositivo
./scripts/explore_device.sh --quick

# Remover bloatware (modo interativo)
./scripts/cleanup_bloatware.sh

# Remover bloatware (tudo automatico)
./scripts/cleanup_bloatware.sh --all

# Restaurar um app removido
./scripts/restore_bloatware.sh com.google.android.youtube

# Screenshot
./scripts/adb_utils.sh screenshot

# Info de um app
./scripts/adb_utils.sh info com.whatsapp

# RAM atual
./scripts/adb_utils.sh ram

# Processos rodando
./scripts/adb_utils.sh procs

# WiFi
./scripts/adb_utils.sh wifi
```

## Claude Code Skills

Plugin `adb-tools` instalado em `~/.claude/plugins/adb-tools/` com as seguintes skills:

| Skill | Trigger | Descricao |
|-------|---------|-----------|
| `/adb-explore` | "explorar celular", "info do dispositivo" | Exploracao profunda do dispositivo |
| `/adb-bloatware` | "remover bloatware", "limpar apps" | Remocao segura de apps pre-instalados |
| `/adb-security` | "auditoria de seguranca", "verificar permissoes" | Auditoria de seguranca completa |
| `/adb-whatsapp` | "gerenciar whatsapp", "whatsapp via adb" | Gestao de WhatsApp multi-conta |
| `/adb-automation` | "automatizar celular", "macro adb" | Automacao de UI via ADB |
| `/adb-spam-cleanup` | "parar notificacoes", "bloquear spam" | Limpeza de notificacoes/ads |
| `/adb-performance` | "celular lento", "otimizar performance" | Diagnostico e otimizacao |
