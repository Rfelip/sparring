# Sparring — packaging (standalone, "no Python needed")

Goal: ship Sparring as a **pre-packaged app a user can install without having
Python + PyGObject + WebKit2GTK set up by hand**. The frontend (`web/`) is the
real product; the shell is replaceable.

> **Status (2026-05-29, this machine / Fedora 43): a real Tauri build was run.**
> The crate compiles; **rpm + deb are built, verified, and shippable** (in
> `dist/`). The **AppImage builds with `make build` on a normal desktop shell**,
> but could **not** be packed inside the build sandbox (a known
> linuxdeploy-plugin-gtk symlink bug on this overlay filesystem — details below).
> See "What was verified vs. what still needs a human" at the bottom.

## Options weighed (Fedora / Linux target)

| Option | Bundles | Pros | Cons | Verdict |
|---|---|---|---|---|
| **Tauri (Rust)** | small Rust binary with `web/` **embedded**; system WebKitGTK (rpm/deb) or bundled (AppImage) | No Python; `web/` ports **verbatim**; ~4 MB binary; rpm/deb ~2.5 MB; AppImage self-contained | Needs `tauri-cli` + Rust build + `webkit2gtk4.1-devel`/`libsoup`/`librsvg` headers; AppImage pack via linuxdeploy is finicky in sandboxes | ✅ **Chosen + built (rpm/deb verified)** |
| PyInstaller / Nuitka + AppImage | the GTK/WebKit **Python** app + interpreter | reuses `app/sparring_app.py` | **GObject-introspection + WebKit2 are hard to freeze** (typelibs, GIR, helper processes); fat, high-risk | ⚠️ Documented, not chosen |
| Flatpak | the **whole runtime** | reproducible, sandboxed | ~hundreds-of-MB runtime; bridge↔`cards/` fights the sandbox | ⚠️ Documented, not chosen |

### Why not just keep the Python shell?
It's perfect for a machine that has the deps present and stays the dev/run path. But
"give this to someone who doesn't have PyGObject" is exactly what Tauri solves.

### The bridge in a packaged build
The Python `/__api/*` bridge (card CRUD + appdata mirror) is a **dev/Python-shell**
feature. In the Tauri build there is no Python process, so:

- **State persistence** is handled by the webview. WebKitGTK persists
  `localStorage` to a per-app data dir keyed by the bundle identifier
  (`com.ruanfelipe.sparring`); it's stable, so FSRS progress survives
  quit/relaunch with **zero extra Rust code**. Path:
  `~/.local/share/com.ruanfelipe.sparring/` (Linux).
- **Card CRUD / edit mode** stays disabled: the frontend hides edit mode when
  `Bridge.probe()` (`GET ./__api/ping`) fails — which it does with no Python
  server. Authoring stays a YAML-on-disk + `tools/build.py` workflow.

## The Tauri crate (this repo)

`packaging/tauri/src-tauri/` is the real, buildable Tauri v2 crate:

```
packaging/tauri/
  build.sh             # one-shot driver (rpm+deb via tauri; AppImage from a wiped AppDir)
  README.md            # per-dir build/share notes
  src-tauri/
    Cargo.toml         # pkg "sparring-app" (see gotcha 1), bin "sparring"; tauri 2 + serde
    Cargo.lock         # committed (reproducible builds)
    build.rs           # tauri-build
    tauri.conf.json    # window + bundle; frontendDist = ../../../web (the repo web/)
    src/main.rs        # thin native shell: tauri::Builder::default().run(...)
    icons/             # generated icon set (committed)
    target/  gen/      # build output (gitignored)
```

`frontendDist = ../../../web` embeds the committed `web/` (incl. `decks/*.json`
and vendored KaTeX) into the binary at compile time — **verified**: the compiled
binary contains the deck slug, `sparring.config.json`, and `katex` strings, and
loads them via relative `fetch('./…')` under Tauri's asset protocol.

### Gotcha 1: the crate is named `sparring-app`, not `sparring`
Tauri's build script reserves the bare crate name `sparring` (alongside
`app`/`tauri`/`core`/`build`/`dev`/`test`) and **panics** if `CARGO_PKG_NAME` is
one of them. `Cargo.toml` therefore uses `name = "sparring-app"` with `[[bin]]
name = "sparring"` — the binary, `.desktop` `Exec`, and bundle name stay
`sparring`. Only the Rust crate id differs.

### Gotcha 2: the AppImage / linuxdeploy issues
Tauri packs the `.AppImage` by running `linuxdeploy` (itself an AppImage that
self-mounts via FUSE) + its gtk plugin, both downloaded to `~/.cache/tauri/`.
Three things can bite; `build.sh` addresses all three:
1. **FUSE unavailable** → `build.sh` exports `APPIMAGE_EXTRACT_AND_RUN=1`.
2. **`Could not find plugin: gtk`** → linuxdeploy finds `--plugin gtk` via PATH;
   `build.sh` adds the tauri cache dir (which holds `linuxdeploy-plugin-gtk.sh`).
3. **The gtk plugin's `ln` aborts with `… File exists`** when re-run over an
   already-processed AppDir → `build.sh` **wipes `bundle/appimage` first** so each
   run starts from a virgin AppDir.

> **Known blocker in sandboxed / overlay-FS builds only:** even from a virgin AppDir, the
> gtk plugin here fails with `ln: failed to create symbolic link
> 'Sparring.AppDir/usr/lib/libprintbackend-cups.so': File exists` →
> `ERROR: Failed to run plugin: gtk`. This is an overlay/sandbox filesystem confusing the plugin's symlink-exists check — **not** a repo
> problem. On a normal interactive Fedora shell (real ext4/btrfs, FUSE present)
> `make build` packs the AppImage fine. rpm/deb don't use linuxdeploy and built
> cleanly here.

## Exact build steps (Fedora — run on this machine)

```bash
# 1. Host build deps (one time; root + network)
sudo dnf install -y webkit2gtk4.1-devel libsoup3-devel librsvg2-devel \
                    openssl-devel gtk3-devel gcc patchelf file
#   (rustc + cargo via rustup already on this machine: cargo 1.94, rustc 1.94.)

# 2. Tauri CLI v2 (one time; network)
cargo install tauri-cli --version "^2.0" --locked     # → cargo-tauri 2.11.2

# 3. Build (from the repo root)
make build            # rpm + deb + AppImage → dist/
# or: cd packaging/tauri && ./build.sh
make verify           # smoke-launch the AppImage ~10s (needs a display)
```

## Artifacts

`build.sh` copies everything into `dist/` (gitignored):

| Artifact | `dist/` path | Size | WebKitGTK | Status |
|---|---|---|---|---|
| RPM | `sparring-0.1.0-1.x86_64.rpm` | 2.5 MB | system (declared dep) | **built + verified here** |
| DEB | `sparring_0.1.0_amd64.deb` | 2.5 MB | system (declared dep) | **built + verified here** |
| **AppImage** | `Sparring-0.1.0-x86_64.AppImage` | ~131 MB | bundled inside | **builds on a real desktop** (`make build`); blocked on overlay/sandbox FS |
| Raw binary | `packaging/.../target/release/sparring` | 4.6 MB | system | **built + smoke-launched here** |

Run/share:
- **RPM**: `sudo dnf install ./sparring-0.1.0-1.x86_64.rpm` → launch "Sparring".
- **DEB**: `sudo apt install ./sparring_0.1.0_amd64.deb`.
- **AppImage** (after `make build` on a desktop):
  `chmod +x Sparring-0.1.0-x86_64.AppImage && ./Sparring-0.1.0-x86_64.AppImage`.

## Runtime dependency — differs per artifact

- **RPM / DEB** use the *system* WebKitGTK and **declare** `webkit2gtk4.1`, so
  `dnf`/`apt` pull it in automatically (`sudo dnf install webkit2gtk4.1` /
  `apt install libwebkit2gtk-4.1-0` — present on essentially every modern Linux
  desktop). No Python on the target. This is the "no toolchain, no Python"
  deliverable that's ready today.
- **AppImage** is self-contained — linuxdeploy's gtk plugin vendors the WebKitGTK
  stack inside it, so it runs with no webkit installed at all (just a normal
  desktop). Use it when the target may lack system webkit; otherwise rpm/deb are
  smaller.

## What was verified vs. what still needs a human

**Verified on this machine (Fedora 43, 2026-05-29):**
- The crate compiles and links `libwebkit2gtk-4.1.so.0` (cargo "Finished" RC 0).
- **rpm + deb build cleanly** (`cargo tauri build --bundles rpm deb`, RC 0).
- The compiled binary (inside the deb, 4,598,584 bytes) **embeds the frontend**
  (deck slug + `sparring.config.json` + `katex` all present in the binary) and
  links system `webkit2gtk-4.1` with **0 unresolved deps**.
- **Smoke launch:** the raw `sparring` binary ran ~9 s on the live Wayland session
  under `timeout` with **no crash and no stderr errors** (exit 124 =
  still-running-when-killed). It starts, links webkit, and stays up. `make verify`
  does the same against the AppImage once built.
- localStorage persistence path is correct/stable (source-level: webview data dir
  = `dirs::data_dir()/com.ruanfelipe.sparring` → persistent `WebsiteDataManager`).

**AppImage: builds on a normal Fedora desktop, not in a headless sandbox** (see Gotcha 2's blocker).
Run `make build` on a normal Fedora shell; if linuxdeploy's gtk plugin still
errors there, `dnf install fuse` and retry, or share the rpm/deb instead.

**Needs a real GUI session — a headless build can't see pixels, so confirm visually:**
1. Install the rpm/deb (or run the AppImage after `make build`) and open Sparring.
2. The **home/deck list renders** (proves the embedded `fetch('./sparring.config.json')`).
3. Open a deck, **flip a card** (Space) — confirm **KaTeX math** and **bold
   markdown** render.
4. Rate a few cards, **quit, relaunch** — the same cards should no longer be due
   (proves localStorage persisted to `~/.local/share/com.ruanfelipe.sparring/`).
5. The **✎ Editar** chip is hidden (no Python bridge → read-only study, by design).

## Fallback (not needed)
PyInstaller/Nuitka one-file bundle of `app/sparring_app.py` — but freezing
PyGObject + WebKit2 is fragile and fat, and the Tauri rpm/deb already deliver a
compiled, no-Python, shareable app, so it was not pursued.
