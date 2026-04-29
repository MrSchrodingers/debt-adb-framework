#!/usr/bin/env bash
# bootstrap-poco-device.sh
#
# CLI HITL bootstrap that reproduces the POCO #1 reference build on a
# fresh POCO C71 (or Redmi A5 / Tecno Spark Go T603 variant).
#
# Stages:
#   1. Verify root (Magisk + PIF + Zygisk-Assistant prerequisite).
#   2. Create up to 4 secondary users via `cmd user create-user`.
#   3. Bypass Setup Wizard per profile (destructive, root-only).
#   4. Propagate WhatsApp + WAB to every secondary via
#      `pm install-existing`.
#   5. HITL registration loop: operator swaps chips and logs in on the
#      physical device per profile.
#   6. Trigger root extraction, populate Frota chips.
#
# Idempotent. Safe to re-run on a partially provisioned device.
#
# Usage:
#   ./scripts/bootstrap-poco-device.sh <SERIAL> [--dry-run]
#
# Dry-run mode prints every adb invocation without executing the device-
# side commands. Use it to syntax-check the script and inspect the plan.
#
# All HITL prompts are in pt-BR (Brazilian Portuguese).
set -euo pipefail

SERIAL="${1:?Uso: bootstrap-poco-device.sh <SERIAL> [--dry-run]}"
DRY_RUN="false"
if [[ "${2:-}" == "--dry-run" ]]; then
  DRY_RUN="true"
fi

# Conservative defaults for the POCO C71 fleet (2 chips x 4 profiles).
USER_NAMES=(
  "Oralsin 1 1"
  "Oralsin 1 2"
  "Oralsin 1 3"
  "Oralsin 1 4"
)

# ── helpers ─────────────────────────────────────────────────────────────

color_bold="$(printf '\033[1m')"
color_dim="$(printf '\033[2m')"
color_red="$(printf '\033[31m')"
color_grn="$(printf '\033[32m')"
color_yel="$(printf '\033[33m')"
color_rst="$(printf '\033[0m')"

log()  { printf "%s[%s]%s %s\n" "${color_bold}" "bootstrap" "${color_rst}" "$*"; }
info() { printf "%s   %s%s\n" "${color_dim}" "$*" "${color_rst}"; }
ok()   { printf "%s + %s%s\n" "${color_grn}" "$*" "${color_rst}"; }
warn() { printf "%s ! %s%s\n" "${color_yel}" "$*" "${color_rst}"; }
err()  { printf "%s x %s%s\n" "${color_red}" "$*" "${color_rst}"; }

run_adb() {
  if [[ "$DRY_RUN" == "true" ]]; then
    info "[dry-run] adb -s $SERIAL $*"
    return 0
  fi
  adb -s "$SERIAL" "$@"
}

run_adb_capture() {
  if [[ "$DRY_RUN" == "true" ]]; then
    info "[dry-run] adb -s $SERIAL $*"
    echo ""
    return 0
  fi
  adb -s "$SERIAL" "$@" 2>/dev/null || true
}

prompt() {
  if [[ "$DRY_RUN" == "true" ]]; then
    info "[dry-run] (skipping prompt: $*)"
    return 0
  fi
  read -r -p "$(printf '%s%s%s ' "${color_yel}" "$*" "${color_rst}")" REPLY
}

prompt_continue() {
  if [[ "$DRY_RUN" == "true" ]]; then
    info "[dry-run] (skipping pause: $*)"
    return 0
  fi
  read -r -p "$(printf '%s%s [ENTER]%s ' "${color_yel}" "$*" "${color_rst}")"
}

# ── stage 1: verify root ─────────────────────────────────────────────────

stage_verify_root() {
  log "STAGE 1 -- verificar root"
  if [[ "$DRY_RUN" == "true" ]]; then
    info "[dry-run] simulando root OK"
    ok "Root OK (dry-run)"
    return 0
  fi
  local out
  out="$(run_adb_capture shell 'su -c id')"
  if echo "$out" | grep -q 'uid=0'; then
    ok "Root OK ($out)"
    return 0
  fi

  err "Root nao detectado. Saida de 'su -c id': $out"
  cat <<EOF
Para rotear o dispositivo, siga: docs/devices/poco-c71-root-procedure.md

  - Magisk 28.1+
  - PlayIntegrityFork v16
  - Zygisk-Assistant v2.1.4
  - DenyList: com.whatsapp, com.whatsapp.w4b, com.google.android.gms

Quando concluir o root, digite ROOTED para continuar; qualquer outra
coisa aborta.
EOF
  prompt "Digite ROOTED para confirmar:"
  if [[ "${REPLY:-}" != "ROOTED" ]]; then
    err "Abortando -- root nao confirmado."
    exit 1
  fi
  ok "Root confirmado manualmente."
}

# ── stage 2: create secondary users ─────────────────────────────────────

list_user_ids() {
  run_adb_capture shell 'pm list users' \
    | sed -n 's/.*UserInfo{\([0-9]\+\):.*/\1/p'
}

stage_create_users() {
  log "STAGE 2 -- criar usuarios secundarios"
  local existing_ids
  existing_ids="$(list_user_ids | sort -u | tr '\n' ' ')"
  info "Usuarios atualmente existentes: ${existing_ids:-(nenhum)}"

  for name in "${USER_NAMES[@]}"; do
    info "Criando: '$name' ..."
    local out
    out="$(run_adb_capture shell "su -c 'cmd user create-user --user-type android.os.usertype.full.SECONDARY \"$name\"'")"
    if echo "$out" | grep -q 'created user id'; then
      local uid
      uid="$(echo "$out" | sed -n 's/.*created user id \([0-9]\+\).*/\1/p')"
      ok "$name -> uid=$uid"
    elif echo "$out" | grep -qi 'cannot add'; then
      warn "$name: limite de usuarios atingido ou ja existe ($out)"
    else
      warn "$name: resposta inesperada -- $out"
    fi
  done

  log "Usuarios apos criacao:"
  run_adb_capture shell 'pm list users' || true
}

# ── stage 3: bypass setup wizard per secondary user ─────────────────────

stage_bypass_setup_wizard() {
  log "STAGE 3 -- bypass do Setup Wizard por profile (destrutivo)"
  local ids
  # Skip uid 0 (the main user is already provisioned). System clones (uid
  # 25 on POCO #1) are auto-managed; skip them too.
  ids="$(list_user_ids | sort -un | awk '$1 >= 10 && $1 < 20 {print}')"
  if [[ -z "$ids" ]]; then
    warn "Nenhum profile secundario [10..19]. Pule esta etapa."
    return 0
  fi

  prompt "Aplicar bypass para os profiles ($ids)? [y/N]"
  if [[ "${REPLY:-}" != "y" && "${REPLY:-}" != "Y" ]]; then
    warn "Bypass pulado por escolha do operador."
    return 0
  fi

  for uid in $ids; do
    info "P$uid -- iniciando user, desabilitando wizard packages, marcando setup-complete"
    run_adb shell "su -c 'am start-user $uid'" || true
    for pkg in com.google.android.setupwizard com.android.provision com.miui.cloudbackup; do
      run_adb shell "su -c 'pm disable --user $uid $pkg'" || true
    done
    run_adb shell "su -c 'settings put --user $uid secure user_setup_complete 1'" || true
    run_adb shell "su -c 'settings put --user $uid global setup_wizard_has_run 1'" || true
    run_adb shell "su -c 'settings put --user $uid global device_provisioned 1'" || true
    run_adb shell "su -c 'am start --user $uid -a android.intent.action.MAIN -c android.intent.category.HOME'" || true
    ok "P$uid bypass aplicado"
  done
}

# ── stage 4: install whatsapp per user ──────────────────────────────────

stage_install_wa() {
  log "STAGE 4 -- propagar WhatsApp para os profiles"
  local ids
  ids="$(list_user_ids | sort -un | awk '$1 >= 10 && $1 < 20 {print}')"
  if [[ -z "$ids" ]]; then
    warn "Sem profiles secundarios [10..19] para propagar."
    return 0
  fi
  for uid in $ids; do
    for pkg in com.whatsapp com.whatsapp.w4b; do
      info "P$uid -- pm install-existing $pkg"
      run_adb shell "cmd package install-existing --user $uid $pkg" || true
    done
  done
  ok "Propagacao concluida (idempotente)."
}

# ── stage 5: HITL registration loop ─────────────────────────────────────

stage_register_wa() {
  log "STAGE 5 -- registro HITL por profile"
  local ids
  ids="$(list_user_ids | sort -un | awk '$1 >= 10 && $1 < 20 {print}')"
  if [[ -z "$ids" ]]; then
    warn "Sem profiles secundarios para registrar."
    return 0
  fi
  for uid in $ids; do
    log "Registro do P$uid"
    prompt_continue "Insira o chip do numero correspondente ao P$uid no slot SIM ativo. Pressione ENTER quando o chip estiver instalado."
    info "Abrindo WhatsApp em P$uid"
    run_adb shell "am start --user $uid -n com.whatsapp/com.whatsapp.HomeActivity" || true
    prompt_continue "WhatsApp aberto em P$uid. No proprio device: cole o telefone, receba e digite o codigo SMS. Pressione ENTER apos o login concluido."
    prompt_continue "Troque o chip para o proximo numero (se aplicavel) e pressione ENTER."
  done
}

# ── stage 6: trigger root extract ───────────────────────────────────────

stage_finalize() {
  log "STAGE 6 -- extracao root + atualizacao da Frota"
  local env_path key
  env_path="${DISPATCH_ENV_PATH:-/var/www/debt-adb-framework/packages/core/.env}"
  if [[ -f "$env_path" ]]; then
    key="$(grep -E '^DISPATCH_API_KEY=' "$env_path" | cut -d= -f2- | tr -d '"' | head -1 || true)"
  fi
  if [[ -z "${key:-}" ]]; then
    warn "DISPATCH_API_KEY nao encontrado em $env_path."
    prompt "Cole o valor de DISPATCH_API_KEY (ou ENTER para pular):"
    key="${REPLY:-}"
  fi
  if [[ -z "$key" ]]; then
    warn "Sem API key -- pulando finalizacao remota. Rode manualmente:"
    info "  curl -X POST -H 'X-API-Key: <KEY>' http://127.0.0.1:8080/api/v1/devices/$SERIAL/extract-phones-root"
    return 0
  fi
  if [[ "$DRY_RUN" == "true" ]]; then
    info "[dry-run] curl POST /api/v1/devices/$SERIAL/extract-phones-root"
    return 0
  fi
  local response
  response="$(curl -sS -X POST -H "X-API-Key: $key" \
    "http://127.0.0.1:8080/api/v1/devices/$SERIAL/extract-phones-root" || true)"
  if command -v jq >/dev/null 2>&1; then
    echo "$response" | jq .
  else
    echo "$response"
  fi
  ok "Verifique os chips em /admin/frota."
}

# ── main ────────────────────────────────────────────────────────────────

main() {
  log "Bootstrap POCO C71 -- serial=$SERIAL dry_run=$DRY_RUN"
  stage_verify_root
  stage_create_users
  stage_bypass_setup_wizard
  stage_install_wa
  stage_register_wa
  stage_finalize
  ok "Bootstrap concluido."
}

main "$@"
