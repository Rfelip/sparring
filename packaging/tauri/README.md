# Sparring — Tauri standalone build

This directory builds Sparring as a **standalone desktop app with no Python and
no toolchain on the target machine**. The product is the `web/` frontend
(study mode: load `web/decks/*.json`, render with vendored KaTeX, schedule with
FSRS-5, persist progress in localStorage). Tauri wraps it in a Rust binary — no
CDN, no localhost server, no `serve.sh`. The **AppImage bundles WebKitGTK
inside**, so it runs with no system webkit either.

## Layout

```
packaging/tauri/
  build.sh             # one-shot driver (rpm+deb via tauri, AppImage via linuxdeploy)
  README.md            # this file
  src-tauri/           # the real Tauri v2 crate
    Cargo.toml         # pkg "sparring-app" (Tauri reserves "sparring"); bin "sparring"
    Cargo.lock         # committed for reproducible builds
    build.rs           # tauri-build
    tauri.conf.json    # window + bundle config; frontendDist = ../../../web (repo web/)
    src/main.rs        # thin native shell around the bundled frontend
    icons/             # generated icon set (committed)
    target/            # build output (gitignored)
```

## Build (Fedora — verified on this machine, 2026-05-29)

```bash
# 1. Host build deps (once; needs root + network)
sudo dnf install -y webkit2gtk4.1-devel libsoup3-devel librsvg2-devel \
                    openssl-devel gtk3-devel gcc patchelf file

# 2. Tauri CLI v2 (once; needs network)
cargo install tauri-cli --version "^2.0" --locked   # installs cargo-tauri 2.x

# 3. Build (from packaging/tauri/)
./build.sh
```

`build.sh` builds rpm+deb with Tauri, then builds the AppImage from a wiped
(virgin) bundle dir (see the gotchas below), and copies all three into `../../dist/`:

| Artifact | `dist/` path | ~Size | WebKitGTK |
|---|---|---|---|
| **AppImage** | `Sparring-0.1.0-x86_64.AppImage` | **131 MB** | **bundled — no host dep** |
| RPM | `sparring-0.1.0-1.x86_64.rpm` | 2.5 MB | system (declared dep) |
| DEB | `sparring_0.1.0_amd64.deb` | 2.5 MB | system (declared dep) |

(Raw binary: `src-tauri/target/release/sparring`, ~2.5 MB.)

## Sharing / running

- **AppImage** (easiest, self-contained):
  `chmod +x Sparring-0.1.0-x86_64.AppImage && ./Sparring-0.1.0-x86_64.AppImage`
  or double-click in a file manager. No Python, no system webkit needed.
- **RPM**: `sudo dnf install ./sparring-0.1.0-1.x86_64.rpm` → launch "Sparring".
- **DEB**: `sudo apt install ./sparring_0.1.0_amd64.deb`.

## Runtime dependency — differs per artifact

- **AppImage**: self-contained. `linuxdeploy-plugin-gtk` vendors the WebKitGTK
  stack inside it, so it runs on any normal Linux desktop (X11/Wayland, glibc)
  with no webkit installed. Cost: ~131 MB. (Not a static musl binary — still a
  desktop app.)
- **RPM / DEB**: kept small by using the *system* WebKitGTK. They **declare** the
  `webkit2gtk4.1` dependency, so `dnf`/`apt` install it automatically:
  `sudo dnf install webkit2gtk4.1` / `sudo apt install libwebkit2gtk-4.1-0`
  (present on essentially every modern Linux desktop).

## The linuxdeploy gotchas (handled by build.sh)

Tauri packs the `.AppImage` by running `linuxdeploy` (itself an AppImage) + its
gtk plugin. Three things bite in containers / CI / sandboxed shells, and
`build.sh` works around all three:

1. **FUSE may be unavailable** → run linuxdeploy under `APPIMAGE_EXTRACT_AND_RUN=1`
   (and, if its self-mount still fails, via the extracted `AppRun`). No FUSE.
2. **`ERROR: Could not find plugin: gtk`** → linuxdeploy finds `--plugin gtk` via
   PATH (the plugin is `~/.cache/tauri/linuxdeploy-plugin-gtk.sh` that Tauri
   downloaded), so `build.sh` puts that cache dir on PATH.
3. **The gtk plugin's `ln` aborts with `File exists`** when re-run over an AppDir
   linuxdeploy already processed → `build.sh` **wipes `bundle/appimage` first** so
   each run packs from a virgin AppDir. (This was the actual failure on this machine.)

On a clean desktop with working FUSE, plain `cargo tauri build` also works from a
clean tree; `build.sh` just makes the AppImage step deterministic.

## Data / persistence

Study progress (FSRS state + settings) lives in the webview's **localStorage**,
which WebKitGTK persists to a per-app data dir keyed by the bundle identifier
`com.ruanfelipe.sparring`:

```
~/.local/share/com.ruanfelipe.sparring/    (Linux; $XDG_DATA_HOME/<identifier>)
```

The identifier is stable, so progress survives quitting and relaunching. The
Python dev-shell `/__api` appdata mirror and card-CRUD edit mode are **absent**
in this build by design — the frontend's `Bridge` probe fails, the edit chip
hides, and the app runs read-only study mode. Authoring cards stays a
YAML-on-disk + `tools/build.py` workflow on the dev machine.

## Regenerating the icon

```bash
cd src-tauri
cargo tauri icon /path/to/source-512.png -o icons
```
