#!/bin/bash
# =============================================================================
# restore_bloatware.sh - Restaura apps removidos pelo cleanup
# =============================================================================
# Uso:
#   ./restore_bloatware.sh                        # Restaura TODOS os removidos
#   ./restore_bloatware.sh com.google.android.youtube  # Restaura 1 app
#   ./restore_bloatware.sh --list                  # Lista apps restauraveis
#   ./restore_bloatware.sh --category google       # Restaura categoria inteira
#
# Categorias: xiaomi, facebook, google, other
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Todos os pacotes removidos na limpeza de 2026-04-01
XIAOMI_PACKAGES=(
  com.miui.msa.global
  com.xiaomi.mipicks
  com.xiaomi.discover
  com.miui.analytics.go
  com.miui.player
  com.miui.videoplayer
  com.miui.theme.lite
  com.miui.bugreport
  com.miui.cleaner.go
  com.miui.android.fashiongallery
  com.miui.qr
  com.xiaomi.scanner
  com.xiaomi.glgm
  com.mi.globalminusscreen
)

FACEBOOK_PACKAGES=(
  com.facebook.system
  com.facebook.services
  com.facebook.appmanager
)

GOOGLE_PACKAGES=(
  com.google.android.youtube
  com.google.android.apps.youtube.music
  com.google.android.gm
  com.google.android.apps.docs
  com.google.android.apps.maps
  com.google.android.apps.tachyon
  com.google.android.apps.messaging
  com.google.android.apps.photosgo
  com.google.android.apps.searchlite
  com.google.android.apps.wellbeing
  com.google.android.apps.safetyhub
  com.google.android.videos
  com.google.android.apps.subscriptions.red
  com.google.android.apps.nbu.files
  com.google.android.marvin.talkback
  com.google.android.apps.walletnfcrel
  com.google.android.apps.restore
  com.google.android.devicelockcontroller
  com.google.android.feedback
)

OTHER_PACKAGES=(
  com.amazon.appmanager
  com.go.browser
  com.android.fmradio
  br.com.timbrasil.meutim
  com.google.android.safetycore
)

ALL_PACKAGES=(
  "${XIAOMI_PACKAGES[@]}"
  "${FACEBOOK_PACKAGES[@]}"
  "${GOOGLE_PACKAGES[@]}"
  "${OTHER_PACKAGES[@]}"
)

get_active_users() {
  adb shell pm list users 2>/dev/null | grep -oP '\{(\d+):' | tr -d '{:' | sort -n
}

restore_pkg() {
  local pkg="$1"
  local users
  users=$(get_active_users)
  local success=false

  for user in $users; do
    local result
    result=$(adb shell cmd package install-existing --user "$user" "$pkg" 2>&1 | tr -d '\r')
    if echo "$result" | grep -qi "installed\|success"; then
      echo -e "  ${GREEN}OK${NC}  user:$user  $pkg"
      success=true
    else
      echo -e "  ${YELLOW}--${NC}  user:$user  $pkg  ($result)"
    fi
  done

  if $success; then
    echo -e "${GREEN}Restaurado:${NC} $pkg"
  else
    echo -e "${RED}Falha ao restaurar:${NC} $pkg (pode nao existir no sistema)"
  fi
}

list_packages() {
  echo -e "${CYAN}=== Pacotes restauraveis ===${NC}"
  echo ""
  echo -e "${YELLOW}XIAOMI (${#XIAOMI_PACKAGES[@]}):${NC}"
  printf '  %s\n' "${XIAOMI_PACKAGES[@]}"
  echo ""
  echo -e "${YELLOW}FACEBOOK (${#FACEBOOK_PACKAGES[@]}):${NC}"
  printf '  %s\n' "${FACEBOOK_PACKAGES[@]}"
  echo ""
  echo -e "${YELLOW}GOOGLE (${#GOOGLE_PACKAGES[@]}):${NC}"
  printf '  %s\n' "${GOOGLE_PACKAGES[@]}"
  echo ""
  echo -e "${YELLOW}OTHER (${#OTHER_PACKAGES[@]}):${NC}"
  printf '  %s\n' "${OTHER_PACKAGES[@]}"
  echo ""
  echo "Total: ${#ALL_PACKAGES[@]} pacotes"
}

main() {
  local arg="${1:-}"

  if ! adb devices | grep -q "device$"; then
    echo -e "${RED}Nenhum dispositivo conectado.${NC}"
    exit 1
  fi

  case "$arg" in
    --list|-l)
      list_packages
      ;;
    --category|-c)
      local cat="${2:-}"
      case "$cat" in
        xiaomi)   for p in "${XIAOMI_PACKAGES[@]}"; do restore_pkg "$p"; done ;;
        facebook) for p in "${FACEBOOK_PACKAGES[@]}"; do restore_pkg "$p"; done ;;
        google)   for p in "${GOOGLE_PACKAGES[@]}"; do restore_pkg "$p"; done ;;
        other)    for p in "${OTHER_PACKAGES[@]}"; do restore_pkg "$p"; done ;;
        *) echo "Categorias: xiaomi, facebook, google, other"; exit 1 ;;
      esac
      echo -e "\n${YELLOW}Reinicie o dispositivo: adb reboot${NC}"
      ;;
    "")
      echo -e "${CYAN}Restaurando TODOS os ${#ALL_PACKAGES[@]} pacotes...${NC}"
      echo -e "${YELLOW}Tem certeza? [s/N]${NC}"
      read -r answer
      if [[ "$answer" != [sS] ]]; then
        echo "Cancelado."
        exit 0
      fi
      for p in "${ALL_PACKAGES[@]}"; do
        restore_pkg "$p"
      done
      echo -e "\n${GREEN}Restauracao completa.${NC}"
      echo -e "${YELLOW}Reinicie o dispositivo: adb reboot${NC}"
      ;;
    *)
      echo -e "Restaurando pacote: ${CYAN}$arg${NC}"
      restore_pkg "$arg"
      echo -e "\n${YELLOW}Reinicie o dispositivo: adb reboot${NC}"
      ;;
  esac
}

main "$@"
