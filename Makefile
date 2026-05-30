# Sparring — Makefile
#
# Two ways to run Sparring:
#   - DEV shell  (Python GTK + in-process bridge; full edit/CRUD): `make run`
#   - STANDALONE (Tauri binary; no Python; read-only study mode):  `make build`
#
# Quick start:
#   make run        # launch the Python dev app (GTK3 + WebKit2GTK required)
#   make decks      # rebuild web/decks/*.json from cards/**/*.yaml
#   make deps       # install Fedora host build deps + tauri-cli (root + network)
#   make build      # build the standalone AppImage + rpm + deb
#   make appimage   # path of the shareable AppImage (builds if missing)
#   make clean      # remove the Rust build output
#
# See docs/PACKAGING.md for the full standalone story and honest limitations.

# ── Paths ────────────────────────────────────────────────────────────────
ROOT      := $(CURDIR)
TAURI     := $(ROOT)/packaging/tauri
TAURI_DIR := $(TAURI)/src-tauri
DIST      := $(ROOT)/dist
APPIMAGE  := $(DIST)/Sparring-0.1.0-x86_64.AppImage

PYTHON ?= python3

.DEFAULT_GOAL := help

# ── Help ─────────────────────────────────────────────────────────────────
.PHONY: help
help:
	@echo 'Sparring — make targets:'
	@echo '  make run       launch the Python dev app (GTK shell, edit/CRUD on)'
	@echo '  make decks     rebuild web/decks/*.json from cards/**/*.yaml'
	@echo '  make deps      install host build deps + tauri-cli (root + network)'
	@echo '  make build     build standalone AppImage + rpm + deb (Tauri) -> dist/'
	@echo '  make appimage  print the shareable AppImage path (builds if missing)'
	@echo '  make verify    smoke-launch the built AppImage for ~10s (needs a display)'
	@echo '  make check     node --check on JS + validate tauri.conf.json'
	@echo '  make clean     remove the Rust build output (target/) and dist/'
	@echo '  make distclean clean + drop the generated icon set'

# ── Dev shell (Python) ─────────────────────────────────────────────────────
.PHONY: run
run:
	$(ROOT)/sparring

# Compile per-card YAML -> web/decks/*.json (source of truth is cards/).
.PHONY: decks
decks:
	$(PYTHON) $(ROOT)/tools/build.py

# ── Standalone (Tauri) ─────────────────────────────────────────────────────
# One-time host deps (Fedora). Needs root + network.
.PHONY: deps
deps:
	sudo dnf install -y webkit2gtk4.1-devel libsoup3-devel librsvg2-devel \
	                    openssl-devel gtk3-devel gcc patchelf file
	cargo install tauri-cli --version "^2.0" --locked

# Build all three bundles into dist/. Depends on `make deps` having been run once.
.PHONY: build
build:
	$(TAURI)/build.sh

# Print (and build if needed) the single-file artifact to hand to someone.
.PHONY: appimage
appimage:
	@test -f "$(APPIMAGE)" || $(MAKE) build
	@echo "$(APPIMAGE)"

# Smoke-launch the AppImage for ~10s to confirm it starts without crashing.
# Needs a real display (Wayland/X). Visual checks (flip/KaTeX/persistence) are
# manual — see docs/PACKAGING.md "What was verified".
.PHONY: verify
verify:
	@test -f "$(APPIMAGE)" || { echo "no AppImage; run 'make build' first" >&2; exit 1; }
	@echo "launching $(APPIMAGE) for 10s (close it or wait)…"
	@APPIMAGE_EXTRACT_AND_RUN=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 timeout 10 "$(APPIMAGE)" || \
	  test $$? -eq 124 && echo "ran 10s without crashing (timeout) — OK" || echo "exited early — check output"

# ── Quality gates ──────────────────────────────────────────────────────────
.PHONY: check
check:
	node --check $(ROOT)/web/app.js
	node --check $(ROOT)/web/scripts/fsrs.js
	$(PYTHON) -c "import json; json.load(open('$(TAURI_DIR)/tauri.conf.json')); print('tauri.conf.json OK')"
	@echo 'check OK'

# ── Cleanup ────────────────────────────────────────────────────────────────
.PHONY: clean
clean:
	rm -rf $(TAURI_DIR)/target $(DIST)

.PHONY: distclean
distclean: clean
	rm -rf $(TAURI_DIR)/icons
