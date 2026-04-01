#!/bin/bash
# =============================================================================
# adb_utils.sh - Utilidades ADB para operacoes comuns no smartphone
# =============================================================================
# Uso: ./adb_utils.sh <comando> [args]
#
# Comandos:
#   screenshot [nome]       Captura screenshot e salva em reports/
#   screenrecord [seg]      Grava tela por N segundos (default: 10)
#   open <pkg>              Abre um app pelo package name
#   kill <pkg>              Forca parada de um app
#   clear <pkg>             Limpa dados de um app
#   info <pkg>              Mostra detalhes de um pacote
#   search <termo>          Busca pacotes por nome
#   notify                  Lista notificacoes ativas
#   wake                    Acorda a tela
#   lock                    Bloqueia a tela
#   tap <x> <y>             Toque na tela
#   swipe <x1> <y1> <x2> <y2>  Swipe na tela
#   type <texto>            Digita texto
#   back                    Botao voltar
#   home                    Botao home
#   reboot                  Reinicia o dispositivo
#   logcat [filtro]         Mostra logs (Ctrl+C para parar)
#   install <apk>           Instala APK
#   pull <path> [dest]      Copia arquivo do dispositivo
#   push <file> <path>      Envia arquivo para o dispositivo
#   shell                   Abre shell interativo
#   apps                    Lista apps visiveis (com labels)
#   ram                     Mostra uso de RAM
#   procs                   Lista processos em execucao
#   wifi                    Info da conexao WiFi
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPORT_DIR="$(dirname "$SCRIPT_DIR")/reports"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

check_device() {
  if ! adb devices 2>/dev/null | grep -q "device$"; then
    echo -e "${RED}Dispositivo nao conectado.${NC}"
    exit 1
  fi
}

cmd_screenshot() {
  local name="${1:-screenshot_$(date +%Y%m%d_%H%M%S)}"
  local remote="/sdcard/${name}.png"
  local local_path="$REPORT_DIR/${name}.png"
  mkdir -p "$REPORT_DIR"

  adb shell screencap -p "$remote"
  adb pull "$remote" "$local_path" 2>/dev/null
  adb shell rm "$remote"
  echo -e "${GREEN}Screenshot salvo:${NC} $local_path"
}

cmd_screenrecord() {
  local seconds="${1:-10}"
  local name="record_$(date +%Y%m%d_%H%M%S)"
  local remote="/sdcard/${name}.mp4"
  local local_path="$REPORT_DIR/${name}.mp4"
  mkdir -p "$REPORT_DIR"

  echo -e "${YELLOW}Gravando ${seconds}s... (Ctrl+C para parar)${NC}"
  adb shell screenrecord --time-limit "$seconds" "$remote"
  adb pull "$remote" "$local_path" 2>/dev/null
  adb shell rm "$remote"
  echo -e "${GREEN}Video salvo:${NC} $local_path"
}

cmd_open() {
  local pkg="$1"
  adb shell monkey -p "$pkg" -c android.intent.category.LAUNCHER 1 2>/dev/null
  echo -e "${GREEN}Aberto:${NC} $pkg"
}

cmd_kill() {
  local pkg="$1"
  adb shell am force-stop "$pkg"
  echo -e "${GREEN}Parado:${NC} $pkg"
}

cmd_clear() {
  local pkg="$1"
  echo -e "${YELLOW}Isso vai APAGAR todos os dados do app $pkg. Continuar? [s/N]${NC}"
  read -r answer
  if [[ "$answer" == [sS] ]]; then
    adb shell pm clear "$pkg"
    echo -e "${GREEN}Dados limpos:${NC} $pkg"
  else
    echo "Cancelado."
  fi
}

cmd_info() {
  local pkg="$1"
  echo -e "${CYAN}=== $pkg ===${NC}"

  local version
  version=$(adb shell dumpsys package "$pkg" 2>/dev/null | grep "versionName" | head -1 | awk -F= '{print $2}')
  local install_time
  install_time=$(adb shell dumpsys package "$pkg" 2>/dev/null | grep "firstInstallTime" | head -1 | awk -F= '{print $2}')
  local data_size
  data_size=$(adb shell du -sh "/data/data/$pkg" 2>/dev/null | awk '{print $1}')
  local enabled
  enabled=$(adb shell pm list packages -e 2>/dev/null | grep -c "$pkg" || echo "0")

  echo "  Versao:     ${version:-N/A}"
  echo "  Instalado:  ${install_time:-N/A}"
  echo "  Dados:      ${data_size:-N/A}"
  echo "  Habilitado: $([ "$enabled" -gt 0 ] && echo 'Sim' || echo 'Nao')"

  echo ""
  echo "  Permissoes:"
  adb shell dumpsys package "$pkg" 2>/dev/null | grep "android.permission" | head -20 | sed 's/^/    /'
}

cmd_search() {
  local term="$1"
  echo -e "${CYAN}Pacotes contendo '$term':${NC}"
  adb shell pm list packages 2>/dev/null | grep -i "$term" | sed 's/package:/  /'
}

cmd_notify() {
  echo -e "${CYAN}=== Notificacoes Ativas ===${NC}"
  adb shell "dumpsys notification --noredact" 2>/dev/null | grep -oP 'pkg=\K[^ ]+' | sort | uniq -c | sort -rn | while read -r count pkg; do
    printf "  %4s  %s\n" "$count" "$pkg"
  done
}

cmd_input() {
  case "$1" in
    wake)  adb shell input keyevent KEYCODE_WAKEUP ;;
    lock)  adb shell input keyevent KEYCODE_SLEEP ;;
    tap)   adb shell input tap "$2" "$3" ;;
    swipe) adb shell input swipe "$2" "$3" "$4" "$5" ;;
    type)  shift; adb shell input text "$*" ;;
    back)  adb shell input keyevent KEYCODE_BACK ;;
    home)  adb shell input keyevent KEYCODE_HOME ;;
  esac
}

cmd_apps() {
  echo -e "${CYAN}=== Apps Instalados (terceiros) ===${NC}"
  adb shell pm list packages -3 2>/dev/null | sed 's/package://' | sort | while read -r pkg; do
    echo "  $pkg"
  done
  echo ""
  local count
  count=$(adb shell pm list packages -3 2>/dev/null | wc -l)
  echo "Total: $count apps"
}

cmd_ram() {
  echo -e "${CYAN}=== Uso de RAM ===${NC}"
  local mem_total mem_avail mem_free
  mem_total=$(adb shell cat /proc/meminfo | grep MemTotal | awk '{print $2}')
  mem_avail=$(adb shell cat /proc/meminfo | grep MemAvailable | awk '{print $2}')
  mem_free=$(adb shell cat /proc/meminfo | grep MemFree | awk '{print $2}')

  local total_mb=$((mem_total / 1024))
  local avail_mb=$((mem_avail / 1024))
  local free_mb=$((mem_free / 1024))
  local used_mb=$((total_mb - avail_mb))
  local pct=$((used_mb * 100 / total_mb))

  echo "  Total:      ${total_mb} MB"
  echo "  Usado:      ${used_mb} MB (${pct}%)"
  echo "  Disponivel: ${avail_mb} MB"
  echo "  Livre:      ${free_mb} MB"

  echo ""
  echo "  Top consumidores:"
  adb shell dumpsys meminfo 2>/dev/null | grep -E "^\s+[0-9].*K:" | head -15 | sed 's/^/  /'
}

cmd_procs() {
  echo -e "${CYAN}=== Processos em Execucao ===${NC}"
  adb shell "dumpsys activity processes" 2>/dev/null | grep -E "^\s+\*.*:.*/" | sed 's/^\s*/  /'
}

cmd_wifi() {
  echo -e "${CYAN}=== WiFi ===${NC}"
  local ssid ip freq tx_speed rx_speed rssi
  ssid=$(adb shell dumpsys wifi 2>/dev/null | grep -oP 'SSID: "\K[^"]+' | head -1)
  ip=$(adb shell ip addr show wlan0 2>/dev/null | grep "inet " | awk '{print $2}')
  freq=$(adb shell dumpsys wifi 2>/dev/null | grep -oP 'Frequency: \K[0-9]+' | head -1)
  tx_speed=$(adb shell dumpsys wifi 2>/dev/null | grep -oP 'Tx Link speed: \K[0-9]+' | head -1)
  rx_speed=$(adb shell dumpsys wifi 2>/dev/null | grep -oP 'Rx Link speed: \K[0-9]+' | head -1)
  rssi=$(adb shell dumpsys wifi 2>/dev/null | grep -oP 'RSSI: \K-?[0-9]+' | head -1)

  echo "  SSID:       ${ssid:-Desconectado}"
  echo "  IP:         ${ip:-N/A}"
  echo "  Frequencia: ${freq:-N/A} MHz"
  echo "  TX Speed:   ${tx_speed:-N/A} Mbps"
  echo "  RX Speed:   ${rx_speed:-N/A} Mbps"
  echo "  RSSI:       ${rssi:-N/A} dBm"
}

# --- Main ---
usage() {
  echo "Uso: $(basename "$0") <comando> [args]"
  echo ""
  echo "Comandos:"
  echo "  screenshot [nome]          Captura screenshot"
  echo "  screenrecord [seg]         Grava tela (default 10s)"
  echo "  open <pkg>                 Abre app"
  echo "  kill <pkg>                 Para app"
  echo "  clear <pkg>                Limpa dados do app"
  echo "  info <pkg>                 Info detalhada do pacote"
  echo "  search <termo>             Busca pacotes"
  echo "  notify                     Notificacoes ativas"
  echo "  wake / lock                Acorda / bloqueia tela"
  echo "  tap <x> <y>               Toque na tela"
  echo "  swipe <x1> <y1> <x2> <y2> Swipe"
  echo "  type <texto>               Digita texto"
  echo "  back / home                Botoes de navegacao"
  echo "  reboot                     Reinicia dispositivo"
  echo "  logcat [filtro]            Logs do Android"
  echo "  install <apk>              Instala APK"
  echo "  pull <path> [dest]         Copia do dispositivo"
  echo "  push <file> <path>         Envia ao dispositivo"
  echo "  shell                      Shell interativo"
  echo "  apps                       Lista apps instalados"
  echo "  ram                        Uso de RAM"
  echo "  procs                      Processos em execucao"
  echo "  wifi                       Info WiFi"
}

main() {
  local cmd="${1:-help}"
  shift || true

  check_device

  case "$cmd" in
    screenshot)   cmd_screenshot "$@" ;;
    screenrecord) cmd_screenrecord "$@" ;;
    open)         cmd_open "$@" ;;
    kill)         cmd_kill "$@" ;;
    clear)        cmd_clear "$@" ;;
    info)         cmd_info "$@" ;;
    search)       cmd_search "$@" ;;
    notify)       cmd_notify ;;
    wake)         cmd_input wake ;;
    lock)         cmd_input lock ;;
    tap)          cmd_input tap "$@" ;;
    swipe)        cmd_input swipe "$@" ;;
    type)         cmd_input type "$@" ;;
    back)         cmd_input back ;;
    home)         cmd_input home ;;
    reboot)       echo -e "${YELLOW}Reiniciando...${NC}"; adb reboot ;;
    logcat)       adb logcat "$@" ;;
    install)      adb install "$@" ;;
    pull)         adb pull "$@" ;;
    push)         adb push "$@" ;;
    shell)        adb shell ;;
    apps)         cmd_apps ;;
    ram)          cmd_ram ;;
    procs)        cmd_procs ;;
    wifi)         cmd_wifi ;;
    help|--help|-h) usage ;;
    *) echo -e "${RED}Comando desconhecido: $cmd${NC}"; usage; exit 1 ;;
  esac
}

main "$@"
