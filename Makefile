# ════════════════════════════════════════════════════════════════════════════
# Dispatch — orchestration Makefile for the physical Kali server.
#
# Quick start (fresh machine):
#   make install && make tailscale-up && make build && make up && make funnel-up
#
# Daily:                 make up  /  make down  /  make attach  /  make logs
# Public tunnel:         make funnel-up  /  make funnel-status  /  make funnel-down
# ════════════════════════════════════════════════════════════════════════════

SHELL           := /bin/bash
.ONESHELL:
.SHELLFLAGS     := -eu -o pipefail -c
.DEFAULT_GOAL   := help

ROOT            := $(shell pwd)
INFRA           := $(ROOT)/infra
SESSION         ?= dispatch
FUNNEL_PORT     ?= 443
CADDY_PORT      ?= 8080
CORE_PORT       ?= 7890
UI_PORT         ?= 5174
HOSTNAME_TS     ?= dispatch
NODE_VERSION    ?= 22

# Colours (only if stdout is a tty)
ifeq ($(shell [ -t 1 ] && echo yes),yes)
  GREEN := \033[0;32m
  BLUE  := \033[0;34m
  YEL   := \033[0;33m
  RED   := \033[0;31m
  NC    := \033[0m
else
  GREEN :=
  BLUE  :=
  YEL   :=
  RED   :=
  NC    :=
endif

define log
	@printf "$(BLUE)▸$(NC) %s\n" "$(1)"
endef

# ─── help ──────────────────────────────────────────────────────────────────
.PHONY: help
help: ## Show this help
	@printf "$(GREEN)Dispatch — physical server orchestration$(NC)\n\n"
	@awk 'BEGIN { FS = ":.*## " } \
	  /^[a-zA-Z0-9_-]+:.*## / { printf "  $(BLUE)%-22s$(NC) %s\n", $$1, $$2 } \
	  /^##@/ { printf "\n$(YEL)%s$(NC)\n", substr($$0, 5) }' $(MAKEFILE_LIST)

# ════════════════════════════════════════════════════════════════════════════
##@ Install (run once on a fresh Kali box — may prompt for sudo)
# ════════════════════════════════════════════════════════════════════════════

.PHONY: install
install: install-system install-node install-pnpm install-adb install-tailscale install-caddy install-deps ## Full bootstrap: apt deps + node + adb + tailscale + caddy + pnpm deps
	$(call log,Install finished. Next: make tailscale-up && make build && make up)

.PHONY: install-system
install-system: ## apt: build tools, git, tmux, curl, jq, ca-certs
	$(call log,apt install base tools)
	sudo apt update
	sudo apt install -y \
	  build-essential git curl wget tmux jq ca-certificates \
	  debian-keyring debian-archive-keyring apt-transport-https \
	  gnupg lsb-release zstd

.PHONY: install-node
install-node: ## Node (version from NODE_VERSION var) via nvm, user-local
	$(call log,Install nvm + node $(NODE_VERSION))
	if [ ! -d "$$HOME/.nvm" ]; then \
	  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash; \
	fi
	export NVM_DIR="$$HOME/.nvm"; \
	  . "$$NVM_DIR/nvm.sh"; \
	  nvm install $(NODE_VERSION); \
	  nvm alias default $(NODE_VERSION); \
	  node -v

.PHONY: install-pnpm
install-pnpm: ## pnpm (via corepack)
	$(call log,Enable corepack + pnpm)
	corepack enable
	corepack prepare pnpm@10.20.0 --activate
	pnpm -v

.PHONY: install-adb
install-adb: ## android-tools + udev rules + plugdev group
	$(call log,Install adb + udev)
	sudo apt install -y android-tools-adb android-sdk-platform-tools-common
	sudo usermod -aG plugdev $$USER || true
	sudo adb kill-server >/dev/null 2>&1 || true
	@echo "$(YEL)Log out/in (or reboot) for plugdev membership to take effect.$(NC)"

.PHONY: install-tailscale
install-tailscale: ## Official Tailscale installer + systemctl enable
	$(call log,Install tailscale)
	if ! command -v tailscale >/dev/null; then \
	  curl -fsSL https://tailscale.com/install.sh | sh; \
	fi
	sudo systemctl enable --now tailscaled
	tailscale version

.PHONY: install-caddy
install-caddy: ## Caddy from the official Cloudsmith repo
	$(call log,Install caddy)
	if ! command -v caddy >/dev/null; then \
	  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
	    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg; \
	  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
	    | sudo tee /etc/apt/sources.list.d/caddy-stable.list; \
	  sudo apt update; \
	  sudo apt install -y caddy; \
	fi
	caddy version

.PHONY: install-deps
install-deps: ## pnpm install (workspace)
	$(call log,pnpm install workspace)
	pnpm install

# ════════════════════════════════════════════════════════════════════════════
##@ Build & test
# ════════════════════════════════════════════════════════════════════════════

.PHONY: build
build: ## Build all packages (turbo)
	$(call log,pnpm build)
	pnpm build

.PHONY: test
test: ## Run test suite
	$(call log,pnpm test)
	pnpm test

.PHONY: lint
lint: ## Lint all packages
	pnpm lint

# ════════════════════════════════════════════════════════════════════════════
##@ Runtime (tmux sessions)
# ════════════════════════════════════════════════════════════════════════════

.PHONY: up
up: _ensure-tmux _ensure-caddy-config ## Start dev session (tmux: core + ui HMR + caddy + tailscale)
	$(call log,Starting tmux session '$(SESSION)' — dev)
	DISPATCH_SESSION=$(SESSION) bash $(INFRA)/tmux-dev.sh

.PHONY: up-prod
up-prod: _ensure-tmux _ensure-caddy-config build ## Start prod-like session (static UI preview)
	$(call log,Starting tmux session '$(SESSION)' — prod-like)
	DISPATCH_SESSION=$(SESSION) bash $(INFRA)/tmux-prod.sh

.PHONY: down
down: ## Kill the tmux session (stops core + ui + caddy)
	$(call log,Killing tmux session '$(SESSION)')
	tmux kill-session -t $(SESSION) 2>/dev/null || true

.PHONY: attach
attach: ## Attach to the running tmux session
	tmux attach -t $(SESSION)

.PHONY: logs
logs: ## Tail all runtime logs
	@mkdir -p $(INFRA)/logs
	@touch $(INFRA)/logs/core.log $(INFRA)/logs/ui.log $(INFRA)/logs/caddy.log
	tail -F $(INFRA)/logs/core.log $(INFRA)/logs/ui.log $(INFRA)/logs/caddy.log

# ════════════════════════════════════════════════════════════════════════════
##@ Caddy
# ════════════════════════════════════════════════════════════════════════════

.PHONY: caddy-validate
caddy-validate: ## Validate infra/Caddyfile
	caddy validate --config $(INFRA)/Caddyfile --adapter caddyfile

.PHONY: caddy-reload
caddy-reload: caddy-validate ## Reload Caddy (system service path)
	sudo caddy reload --config $(INFRA)/Caddyfile --adapter caddyfile

.PHONY: configure-caddy
configure-caddy: caddy-validate ## Install Caddyfile as the system Caddy config
	$(call log,Copy infra/Caddyfile → /etc/caddy/Caddyfile)
	sudo install -m 0644 $(INFRA)/Caddyfile /etc/caddy/Caddyfile
	sudo systemctl enable --now caddy
	sudo systemctl reload caddy

# ════════════════════════════════════════════════════════════════════════════
##@ Tailscale
# ════════════════════════════════════════════════════════════════════════════

.PHONY: tailscale-up
tailscale-up: ## Bring up Tailscale (opens browser-auth URL)
	$(call log,tailscale up (hostname=$(HOSTNAME_TS)))
	sudo tailscale up --ssh --hostname=$(HOSTNAME_TS) --accept-routes

.PHONY: tailscale-down
tailscale-down: ## Disconnect from tailnet
	sudo tailscale down

.PHONY: tailscale-status
tailscale-status: ## tailscale status
	tailscale status

.PHONY: funnel-up
funnel-up: ## Expose Caddy on public HTTPS (default 443)
	$(call log,Enabling Tailscale Funnel → http://127.0.0.1:$(CADDY_PORT))
	sudo tailscale funnel --bg --https=$(FUNNEL_PORT) http://127.0.0.1:$(CADDY_PORT)
	@$(MAKE) --no-print-directory funnel-status

.PHONY: funnel-down
funnel-down: ## Take the public tunnel offline
	sudo tailscale funnel --https=$(FUNNEL_PORT) off

.PHONY: funnel-status
funnel-status: ## Show public URL + funnel state
	@tailscale funnel status || true
	@printf "\n$(GREEN)Public URL:$(NC) https://%s/\n" \
	  "$$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName' | sed 's/\.$$//')"

# ════════════════════════════════════════════════════════════════════════════
##@ Health / diagnostics
# ════════════════════════════════════════════════════════════════════════════

.PHONY: health
health: ## Probe local services (core, ui, caddy, funnel)
	@printf "$(BLUE)→ core  $(NC) "; curl -fsS -m 3 http://127.0.0.1:$(CORE_PORT)/healthz && echo || echo "$(RED)DOWN$(NC)"
	@printf "$(BLUE)→ ui    $(NC) "; curl -fsS -m 3 -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:$(UI_PORT)/ || echo "$(RED)DOWN$(NC)"
	@printf "$(BLUE)→ caddy $(NC) "; curl -fsS -m 3 -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:$(CADDY_PORT)/ || echo "$(RED)DOWN$(NC)"
	@printf "$(BLUE)→ funnel$(NC) "; tailscale funnel status 2>/dev/null | grep -E '^https' || echo "$(YEL)off$(NC)"

.PHONY: doctor
doctor: ## Environment sanity check
	@echo "──── versions ────"
	@command -v node      >/dev/null && node -v      || echo "$(RED)node missing$(NC)"
	@command -v pnpm      >/dev/null && pnpm -v      || echo "$(RED)pnpm missing$(NC)"
	@command -v adb       >/dev/null && adb version | head -1 || echo "$(RED)adb missing$(NC)"
	@command -v caddy     >/dev/null && caddy version | head -1 || echo "$(RED)caddy missing$(NC)"
	@command -v tailscale >/dev/null && tailscale version | head -1 || echo "$(RED)tailscale missing$(NC)"
	@command -v tmux      >/dev/null && tmux -V      || echo "$(RED)tmux missing$(NC)"
	@echo "──── ports ────"
	@ss -ltnp 2>/dev/null | awk 'NR==1 || /:($(CORE_PORT)|$(UI_PORT)|$(CADDY_PORT))\b/' || true
	@echo "──── adb devices ────"
	@adb devices 2>/dev/null || echo "$(YEL)adb not running$(NC)"
	@echo "──── tailscale ────"
	@tailscale status 2>/dev/null | head -5 || echo "$(YEL)tailscale not connected$(NC)"

# ════════════════════════════════════════════════════════════════════════════
# Internal helpers
# ════════════════════════════════════════════════════════════════════════════

.PHONY: _ensure-tmux
_ensure-tmux:
	@command -v tmux >/dev/null || { echo "$(RED)tmux not installed — run: make install-system$(NC)"; exit 1; }

.PHONY: _ensure-caddy-config
_ensure-caddy-config:
	@test -f $(INFRA)/Caddyfile || { echo "$(RED)infra/Caddyfile missing$(NC)"; exit 1; }
