#!/bin/bash
# =============================================================================
# cleanup_bloatware.sh - Remocao de bloatware via ADB (sem root)
# =============================================================================
# Uso:
#   ./cleanup_bloatware.sh                    # Modo interativo (confirma cada categoria)
#   ./cleanup_bloatware.sh --all              # Remove tudo sem perguntar
#   ./cleanup_bloatware.sh --dry-run          # Mostra o que seria removido sem executar
#   ./cleanup_bloatware.sh --category xiaomi  # Remove apenas uma categoria
#   ./cleanup_bloatware.sh --package com.x.y  # Remove um pacote especifico
#
# Categorias: xiaomi, facebook, google, other
#
# Perfis de usuario sao detectados automaticamente.
# Flag -k preserva dados (reinstalavel via Play Store).
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$(dirname "$SCRIPT_DIR")/data"
REPORT_DIR="$(dirname "$SCRIPT_DIR")/reports"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_FILE="$REPORT_DIR/cleanup_${TIMESTAMP}.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

DRY_RUN=false
AUTO_YES=false
REMOVED_COUNT=0
FAILED_COUNT=0
SKIPPED_COUNT=0

# --- Bloatware Lists ---

XIAOMI_BLOAT=(
  "com.miui.msa.global|MIUI System Ads|Ads/tracking da Xiaomi"
  "com.xiaomi.mipicks|GetApps (Mi Picks)|Loja alternativa, spam de notificacoes"
  "com.xiaomi.discover|Xiaomi Discover|Promos e sugestoes"
  "com.miui.analytics.go|MIUI Analytics|Telemetria"
  "com.miui.player|Mi Music|Player de musica nao usado"
  "com.miui.videoplayer|Mi Video|Player de video nao usado"
  "com.miui.theme.lite|Temas MIUI|Servico de temas"
  "com.miui.bugreport|Bug Report|Ferramenta de dev"
  "com.miui.cleaner.go|Cleaner|Limpador desnecessario"
  "com.miui.android.fashiongallery|Mi Wallpaper|Carousel de wallpapers"
  "com.miui.qr|Mi QR Scanner|Redundante (camera ja faz)"
  "com.xiaomi.scanner|Xiaomi Scanner|Scanner redundante"
  "com.xiaomi.glgm|Xiaomi Games|Servico de jogos"
  "com.mi.globalminusscreen|App Vault|Tela -1 do launcher"
)

FACEBOOK_BLOAT=(
  "com.facebook.system|Facebook System|Pre-instalado, roda em background"
  "com.facebook.services|Facebook Services|Servico persistente desnecessario"
  "com.facebook.appmanager|Facebook App Manager|Auto-updater do Facebook"
)

GOOGLE_BLOAT=(
  "com.google.android.youtube|YouTube|Nao usado"
  "com.google.android.apps.youtube.music|YouTube Music|Nao usado"
  "com.google.android.gm|Gmail|Nao usado"
  "com.google.android.apps.docs|Google Drive|Nao usado"
  "com.google.android.apps.maps|Google Maps|Nao usado"
  "com.google.android.apps.tachyon|Google Duo/Meet|Nao usado"
  "com.google.android.apps.messaging|Google Messages|Nao usado"
  "com.google.android.apps.photosgo|Google Photos Go|Nao usado"
  "com.google.android.apps.searchlite|Google Go (Search)|Nao usado"
  "com.google.android.apps.wellbeing|Digital Wellbeing|Roda em background"
  "com.google.android.apps.safetyhub|Personal Safety|Nao usado"
  "com.google.android.videos|Google TV|Nao usado"
  "com.google.android.apps.subscriptions.red|Google One|Nao usado"
  "com.google.android.apps.nbu.files|Files by Google|Nao usado"
  "com.google.android.marvin.talkback|TalkBack|Acessibilidade nao usada"
  "com.google.android.apps.walletnfcrel|Google Wallet|Nao usado"
  "com.google.android.apps.restore|Device Restore|Setup only"
  "com.google.android.devicelockcontroller|Device Lock|Financiamento N/A"
  "com.google.android.feedback|Google Feedback|Nao necessario"
)

OTHER_BLOAT=(
  "com.amazon.appmanager|Amazon App Manager|Pre-instalado Amazon"
  "com.go.browser|Mi Browser Go|Browser bloat"
  "com.android.fmradio|FM Radio|Nao usado"
  "br.com.timbrasil.meutim|Meu TIM|App operadora bloat"
  "com.google.android.safetycore|Safety Core|Scanning service"
)

# --- Helpers ---
log() { echo "[$(date +%H:%M:%S)] $*" >> "$LOG_FILE"; }

check_adb() {
  if ! command -v adb &>/dev/null; then
    echo -e "${RED}ADB nao encontrado.${NC}"
    exit 1
  fi
  if ! adb devices | grep -q "device$"; then
    echo -e "${RED}Nenhum dispositivo conectado/autorizado.${NC}"
    exit 1
  fi
}

get_active_users() {
  adb shell pm list users 2>/dev/null | grep -oP '\{(\d+):' | tr -d '{:' | sort -n
}

backup_packages() {
  mkdir -p "$DATA_DIR"
  local backup_file="$DATA_DIR/packages_before_cleanup_${TIMESTAMP}.txt"
  adb shell pm list packages 2>/dev/null | sed 's/package://' | sort > "$backup_file"
  echo -e "${GREEN}Backup salvo:${NC} $backup_file ($(wc -l < "$backup_file") pacotes)"
  log "Backup: $backup_file"
}

uninstall_for_all_users() {
  local pkg="$1"
  local name="$2"
  local users
  users=$(get_active_users)

  for user in $users; do
    if $DRY_RUN; then
      echo -e "  ${YELLOW}[DRY-RUN]${NC} pm uninstall -k --user $user $pkg"
      log "[DRY-RUN] user:$user $pkg"
    else
      local result
      result=$(adb shell pm uninstall -k --user "$user" "$pkg" 2>&1 | tr -d '\r')
      if [ "$result" = "Success" ]; then
        echo -e "  ${GREEN}OK${NC}  user:$user"
        log "OK user:$user $pkg"
        ((REMOVED_COUNT++)) || true
      elif echo "$result" | grep -q "not installed"; then
        echo -e "  ${YELLOW}--${NC}  user:$user (nao instalado)"
        log "SKIP user:$user $pkg (not installed)"
        ((SKIPPED_COUNT++)) || true
      else
        echo -e "  ${RED}FAIL${NC} user:$user ($result)"
        log "FAIL user:$user $pkg: $result"
        ((FAILED_COUNT++)) || true
      fi
    fi
  done
}

process_category() {
  local category_name="$1"
  shift
  local -n bloat_list="$1"

  echo ""
  echo -e "${CYAN}${BOLD}--- $category_name (${#bloat_list[@]} apps) ---${NC}"
  echo ""

  if ! $AUTO_YES; then
    echo -e "${YELLOW}Remover esta categoria? [s/N/l(listar)]${NC} "
    read -r answer
    case "$answer" in
      l|L)
        for entry in "${bloat_list[@]}"; do
          IFS='|' read -r pkg name desc <<< "$entry"
          printf "  %-45s %-25s %s\n" "$pkg" "$name" "$desc"
        done
        echo ""
        echo -e "${YELLOW}Remover? [s/N]${NC} "
        read -r answer2
        [[ "$answer2" != [sS] ]] && return
        ;;
      s|S) ;;
      *) echo -e "${YELLOW}Pulando $category_name${NC}"; return ;;
    esac
  fi

  for entry in "${bloat_list[@]}"; do
    IFS='|' read -r pkg name desc <<< "$entry"
    echo -e "\n${BOLD}$name${NC} ($pkg)"
    echo "  $desc"
    uninstall_for_all_users "$pkg" "$name"
  done

  log "Categoria $category_name processada"
}

remove_single_package() {
  local pkg="$1"
  echo -e "\n${BOLD}Removendo pacote:${NC} $pkg"
  uninstall_for_all_users "$pkg" "$pkg"
}

# --- Main ---
main() {
  local mode="${1:---interactive}"
  local target="${2:-}"

  mkdir -p "$REPORT_DIR"

  echo "============================================"
  echo "  ADB Bloatware Cleanup"
  echo "  $(date)"
  echo "============================================"

  check_adb

  local users
  users=$(get_active_users)
  local user_count
  user_count=$(echo "$users" | wc -w)
  echo -e "Perfis de usuario ativos: ${BOLD}$user_count${NC} ($(echo $users | tr '\n' ' '))"

  if $DRY_RUN; then
    echo -e "${YELLOW}${BOLD}MODO DRY-RUN: nada sera removido${NC}"
  fi

  log "Inicio da limpeza - modo: $mode"
  log "Usuarios ativos: $users"

  backup_packages

  case "$mode" in
    --all)
      AUTO_YES=true
      process_category "BLOATWARE XIAOMI/MIUI" XIAOMI_BLOAT
      process_category "FACEBOOK SERVICES" FACEBOOK_BLOAT
      process_category "GOOGLE BLOATWARE" GOOGLE_BLOAT
      process_category "OUTROS" OTHER_BLOAT
      ;;
    --dry-run)
      DRY_RUN=true
      AUTO_YES=true
      process_category "BLOATWARE XIAOMI/MIUI" XIAOMI_BLOAT
      process_category "FACEBOOK SERVICES" FACEBOOK_BLOAT
      process_category "GOOGLE BLOATWARE" GOOGLE_BLOAT
      process_category "OUTROS" OTHER_BLOAT
      ;;
    --category)
      AUTO_YES=true
      case "$target" in
        xiaomi)   process_category "BLOATWARE XIAOMI/MIUI" XIAOMI_BLOAT ;;
        facebook) process_category "FACEBOOK SERVICES" FACEBOOK_BLOAT ;;
        google)   process_category "GOOGLE BLOATWARE" GOOGLE_BLOAT ;;
        other)    process_category "OUTROS" OTHER_BLOAT ;;
        *) echo "Categorias: xiaomi, facebook, google, other"; exit 1 ;;
      esac
      ;;
    --package)
      if [ -z "$target" ]; then
        echo "Uso: $0 --package com.example.app"
        exit 1
      fi
      remove_single_package "$target"
      ;;
    --interactive|*)
      process_category "BLOATWARE XIAOMI/MIUI" XIAOMI_BLOAT
      process_category "FACEBOOK SERVICES" FACEBOOK_BLOAT
      process_category "GOOGLE BLOATWARE" GOOGLE_BLOAT
      process_category "OUTROS" OTHER_BLOAT
      ;;
  esac

  echo ""
  echo "============================================"
  echo -e "  ${GREEN}Removidos: $REMOVED_COUNT${NC}"
  echo -e "  ${YELLOW}Pulados:   $SKIPPED_COUNT${NC}"
  echo -e "  ${RED}Falhas:    $FAILED_COUNT${NC}"
  echo "============================================"
  echo -e "Log: $LOG_FILE"

  log "Fim - Removidos: $REMOVED_COUNT, Pulados: $SKIPPED_COUNT, Falhas: $FAILED_COUNT"
}

main "$@"
