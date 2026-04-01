#!/bin/bash
# =============================================================================
# explore_device.sh - Exploracao completa de dispositivo Android via ADB
# =============================================================================
# Uso: ./explore_device.sh [--full | --quick | --section <nome>]
#   --quick   : Apenas info basica (device, RAM, storage, bateria)
#   --full    : Tudo (default)
#   --section : Rodar apenas uma secao especifica
#
# Secoes disponiveis: device, hardware, packages, processes, network,
#                     notifications, usage, battery, storage
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$(dirname "$SCRIPT_DIR")/data"
REPORT_DIR="$(dirname "$SCRIPT_DIR")/reports"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
REPORT_FILE="$REPORT_DIR/explore_${TIMESTAMP}.txt"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# --- Helpers ---
header() { echo -e "\n${CYAN}=== $1 ===${NC}"; }
ok()     { echo -e "${GREEN}[OK]${NC} $1"; }
warn()   { echo -e "${YELLOW}[!]${NC} $1"; }
fail()   { echo -e "${RED}[FAIL]${NC} $1"; }

check_adb() {
  if ! command -v adb &>/dev/null; then
    fail "ADB nao encontrado. Instale: sudo dnf install android-tools"
    exit 1
  fi
  local devices
  devices=$(adb devices | grep -v "List" | grep -c "device$" || true)
  if [ "$devices" -eq 0 ]; then
    fail "Nenhum dispositivo conectado/autorizado."
    fail "Conecte via USB e autorize a depuracao USB no smartphone."
    exit 1
  fi
  ok "Dispositivo conectado ($devices)"
}

prop() { adb shell getprop "$1" 2>/dev/null | tr -d '\r'; }

# --- Secoes ---
section_device() {
  header "DISPOSITIVO"
  echo "  Marca:      $(prop ro.product.brand)"
  echo "  Modelo:     $(prop ro.product.model)"
  echo "  Device:     $(prop ro.product.device)"
  echo "  Product:    $(prop ro.product.name)"
  echo "  Android:    $(prop ro.build.version.release) (SDK $(prop ro.build.version.sdk))"
  echo "  Build:      $(prop ro.build.display.id)"
  echo "  Security:   $(prop ro.build.version.security_patch)"
  echo "  Serial:     $(prop ro.serialno)"
  echo "  Fingerprint:$(prop ro.build.fingerprint)"
  echo ""
  echo "  Usuarios:"
  adb shell pm list users 2>/dev/null | grep "UserInfo" | while read -r line; do
    echo "    $line"
  done
}

section_hardware() {
  header "HARDWARE"

  local mem_total mem_avail
  mem_total=$(adb shell cat /proc/meminfo | grep MemTotal | awk '{print $2}')
  mem_avail=$(adb shell cat /proc/meminfo | grep MemAvailable | awk '{print $2}')
  local mem_total_mb=$((mem_total / 1024))
  local mem_avail_mb=$((mem_avail / 1024))
  local mem_used_mb=$((mem_total_mb - mem_avail_mb))
  local mem_pct=$((mem_used_mb * 100 / mem_total_mb))

  echo "  CPU:        $(prop ro.board.platform) ($(prop ro.product.cpu.abi))"
  local cores
  cores=$(adb shell cat /proc/cpuinfo | grep -c "^processor" || echo "?")
  echo "  Cores:      $cores"
  echo ""
  echo "  RAM Total:  ${mem_total_mb} MB"
  echo "  RAM Usada:  ${mem_used_mb} MB (${mem_pct}%)"
  echo "  RAM Livre:  ${mem_avail_mb} MB"
  echo ""

  echo "  Tela:       $(adb shell wm size 2>/dev/null | awk '{print $NF}')"
  echo "  Densidade:  $(adb shell wm density 2>/dev/null | awk '{print $NF}') dpi"
}

section_storage() {
  header "ARMAZENAMENTO"
  adb shell df -h /data /storage/emulated 2>/dev/null | column -t
  echo ""
  local diskstats
  diskstats=$(adb shell dumpsys diskstats 2>/dev/null | head -8)
  echo "$diskstats"
}

section_battery() {
  header "BATERIA"
  local level status health temp
  level=$(adb shell dumpsys battery | grep "level:" | awk '{print $2}' | tr -d '\r')
  status=$(adb shell dumpsys battery | grep "status:" | awk '{print $2}' | tr -d '\r')
  health=$(adb shell dumpsys battery | grep "health:" | awk '{print $2}' | tr -d '\r')
  temp=$(adb shell dumpsys battery | grep "temperature:" | awk '{print $2}' | tr -d '\r')

  local status_text health_text
  case $status in
    1) status_text="Desconhecido" ;; 2) status_text="Carregando" ;;
    3) status_text="Descarregando" ;; 4) status_text="Nao carregando" ;;
    5) status_text="Completa" ;; *) status_text="$status" ;;
  esac
  case $health in
    1) health_text="Desconhecido" ;; 2) health_text="Boa" ;;
    3) health_text="Superaquecida" ;; 4) health_text="Morta" ;;
    5) health_text="Sobretensao" ;; 6) health_text="Falha" ;;
    *) health_text="$health" ;;
  esac

  local temp_c
  temp_c=$(echo "scale=1; $temp / 10" | bc 2>/dev/null || echo "$temp")

  echo "  Nivel:       ${level}%"
  echo "  Status:      $status_text"
  echo "  Saude:       $health_text"
  echo "  Temperatura: ${temp_c}C"

  local usb ac wireless
  usb=$(adb shell dumpsys battery | grep "USB powered:" | awk '{print $3}' | tr -d '\r')
  ac=$(adb shell dumpsys battery | grep "AC powered:" | awk '{print $3}' | tr -d '\r')
  wireless=$(adb shell dumpsys battery | grep "Wireless powered:" | awk '{print $3}' | tr -d '\r')
  echo "  Fonte:       USB=$usb AC=$ac Wireless=$wireless"
}

section_network() {
  header "REDE"

  local ssid ip freq speed
  ssid=$(adb shell dumpsys wifi 2>/dev/null | grep -oP 'SSID: "\K[^"]+' | head -1)
  ip=$(adb shell ip addr show wlan0 2>/dev/null | grep "inet " | awk '{print $2}')
  freq=$(adb shell dumpsys wifi 2>/dev/null | grep -oP 'Frequency: \K[0-9]+' | head -1)
  speed=$(adb shell dumpsys wifi 2>/dev/null | grep -oP 'Tx Link speed: \K[0-9]+' | head -1)

  echo "  WiFi SSID:   ${ssid:-Desconectado}"
  echo "  IP:          ${ip:-N/A}"
  echo "  Frequencia:  ${freq:-N/A} MHz"
  echo "  Velocidade:  ${speed:-N/A} Mbps"
  echo ""
  echo "  DNS:"
  adb shell getprop net.dns1 2>/dev/null | sed 's/^/    /'
  adb shell getprop net.dns2 2>/dev/null | sed 's/^/    /'
}

section_packages() {
  header "PACOTES"

  local total system user disabled
  total=$(adb shell pm list packages 2>/dev/null | wc -l)
  system=$(adb shell pm list packages -s 2>/dev/null | wc -l)
  user=$(adb shell pm list packages -3 2>/dev/null | wc -l)
  disabled=$(adb shell pm list packages -d 2>/dev/null | wc -l)

  echo "  Total:       $total"
  echo "  Sistema:     $system"
  echo "  Usuario:     $user"
  echo "  Desativados: $disabled"
  echo ""
  echo "  Apps do usuario (terceiros):"
  adb shell pm list packages -3 2>/dev/null | sed 's/package:/    /' | sort
}

section_processes() {
  header "PROCESSOS EM BACKGROUND"
  local procs
  procs=$(adb shell "dumpsys activity processes" 2>/dev/null | grep -E "^\s+\*.*:.*/" || true)
  local count
  count=$(echo "$procs" | wc -l)
  echo "  Total de processos: $count"
  echo ""
  echo "$procs" | sed 's/^\s*/  /'
}

section_notifications() {
  header "NOTIFICACOES ATIVAS"
  adb shell "dumpsys notification --noredact" 2>/dev/null | grep -oP 'pkg=\K[^ ]+' | sort | uniq -c | sort -rn | head -20 | while read -r count pkg; do
    printf "  %4s  %s\n" "$count" "$pkg"
  done
}

section_usage() {
  header "APPS MAIS USADOS (estatisticas)"
  adb shell "dumpsys usagestats" 2>/dev/null | grep -E "package=" | grep -oP 'package=\K[^ ]+' | sort | uniq -c | sort -rn | head -20 | while read -r count pkg; do
    printf "  %4s  %s\n" "$count" "$pkg"
  done
}

# --- Main ---
main() {
  local mode="${1:---full}"
  local section_name="${2:-}"

  echo "============================================"
  echo "  ADB Device Explorer"
  echo "  $(date)"
  echo "============================================"

  check_adb

  case "$mode" in
    --quick)
      section_device
      section_hardware
      section_storage
      section_battery
      ;;
    --section)
      if [ -z "$section_name" ]; then
        echo "Uso: $0 --section <nome>"
        echo "Secoes: device hardware storage battery network packages processes notifications usage"
        exit 1
      fi
      "section_${section_name}"
      ;;
    --full|*)
      section_device
      section_hardware
      section_storage
      section_battery
      section_network
      section_packages
      section_processes
      section_notifications
      section_usage
      ;;
  esac

  echo ""
  header "FIM DA EXPLORACAO"
}

# Executar e salvar relatorio
mkdir -p "$REPORT_DIR"
main "$@" 2>&1 | tee "$REPORT_FILE"
echo -e "\n${GREEN}Relatorio salvo em: $REPORT_FILE${NC}"
