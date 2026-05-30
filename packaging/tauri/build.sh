#!/usr/bin/env bash
# build.sh — produce a standalone Sparring binary + installers with Tauri.
#
# The real Tauri crate lives in ./src-tauri/. Its tauri.conf.json sets
# frontendDist=../../../web, so the committed web/ frontend is embedded into the
# binary verbatim — no Python, no localhost server, no CDN.
#
# Outputs (under src-tauri/target/release/), also copied into ../../dist/ :
#   sparring                                      raw binary (~4 MB)
#   bundle/appimage/Sparring_0.1.0_amd64.AppImage SELF-CONTAINED (~131 MB,
#                                                 bundles WebKitGTK — no host dep)
#   bundle/rpm/Sparring-0.1.0-1.x86_64.rpm        installer (uses system webkit)
#   bundle/deb/Sparring_0.1.0_amd64.deb           installer (uses system webkit)
#
# Prereqs (Fedora; install once, root + network):
#   sudo dnf install -y webkit2gtk4.1-devel libsoup3-devel librsvg2-devel \
#                       openssl-devel gtk3-devel gcc patchelf file
#   cargo install tauri-cli --version "^2.0" --locked
#
# About the AppImage step (read if it ever fails):
#   Tauri packs the .AppImage by running linuxdeploy (itself an AppImage) + its
#   gtk plugin, both downloaded to ~/.cache/tauri/. Three things can bite:
#     1. FUSE unavailable        → APPIMAGE_EXTRACT_AND_RUN=1 (set below) avoids it.
#     2. "Could not find plugin: gtk" → the plugin is found via PATH; we add the
#                                       tauri cache dir to PATH below.
#     3. "ln: ... File exists" from the gtk plugin → it was re-run over an AppDir
#        it already processed. We WIPE bundle/appimage first so each run starts
#        from a virgin AppDir. (This was the actual failure mode on this machine.)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TAURI="$HERE/src-tauri"
B="$TAURI/target/release/bundle"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
export WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"
export APPIMAGE_EXTRACT_AND_RUN="${APPIMAGE_EXTRACT_AND_RUN:-1}"
# gtk plugin discovery (linuxdeploy-plugin-gtk.sh lives in the tauri cache).
[ -d "$CACHE" ] && export PATH="$CACHE:$PATH"

command -v cargo >/dev/null 2>&1 || { echo "error: cargo (Rust) not found. Install rustup first." >&2; exit 1; }
if command -v cargo-tauri >/dev/null 2>&1; then TAURI_CLI="cargo tauri"
else
  echo "→ installing tauri-cli (cargo install tauri-cli --version ^2.0 --locked)…" >&2
  cargo install tauri-cli --version "^2.0" --locked
  TAURI_CLI="cargo tauri"
fi

cd "$TAURI"

# 1. rpm + deb (these never touch linuxdeploy).
echo "[build] rpm + deb…"
$TAURI_CLI build --bundles rpm deb

# 2. AppImage from a VIRGIN bundle dir (see gotcha #3 above).
echo "[build] AppImage (from a wiped/virgin AppDir)…"
rm -rf "$B/appimage"
$TAURI_CLI build --bundles appimage
[ -f "$B/appimage/Sparring_0.1.0_amd64.AppImage" ] || { echo "error: AppImage not produced" >&2; exit 1; }

# 3. Collect to dist/.
mkdir -p "$ROOT/dist"; rm -f "$ROOT"/dist/*
cp "$B/appimage/Sparring_0.1.0_amd64.AppImage" "$ROOT/dist/Sparring-0.1.0-x86_64.AppImage"
cp "$B"/rpm/*.rpm "$ROOT/dist/" 2>/dev/null || true
cp "$B"/deb/*.deb "$ROOT/dist/" 2>/dev/null || true
chmod +x "$ROOT/dist/Sparring-0.1.0-x86_64.AppImage"

echo
echo "✓ done — artifacts in $ROOT/dist/ :"
ls -lh "$ROOT/dist/" | awk 'NR>1{printf "    %s  %s\n",$5,$9}'
echo "  hand someone dist/Sparring-0.1.0-x86_64.AppImage (chmod +x, run). See docs/PACKAGING.md."
