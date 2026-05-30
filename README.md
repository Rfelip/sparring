# Sparring

Active-recall flashcards with **FSRS** scheduling and **KaTeX** math — now a
**native desktop app**, not a browser page you have to serve.

## Run it

```bash
./sparring
```

…or install the desktop entry: copy `sparring.desktop` to
`~/.local/share/applications/` and point its `Exec=` / `TryExec=` at your
checkout (or put the `sparring` launcher on your `PATH`). Then launch
**Sparring** from your app menu.

No `serve.sh`, no localhost tab. The app opens a real GTK window and runs its
own static server in-process on a loopback port that starts and dies with it.

**Keys inside the app:** `Space` flip · `1–4` / `J K L ;` rate · `←` undo ·
`→` skip · `Ctrl+R` reload · `Ctrl+Q` quit · `F11` fullscreen.

## Why it changed

It started life as a browser app you had to serve behind a `./serve.sh`. Three
things were wrong for daily study use:

1. **Math didn't render** — KaTeX was pulled from a CDN with SRI hashes; offline
   or on a hash mismatch the script is blocked and no math appears. KaTeX is now
   **vendored locally** (`web/vendor/katex/`) — works offline, no CDN.
2. **You had to serve it** — now it's a clickable native window.
3. **It was a loose page, not a project** — now it has its own repo, build, and
   packaging.

## Layout

```
sparring/
  sparring              # launcher (bash) — run this
  sparring.desktop      # KDE app-menu entry
  app/
    sparring_app.py     # native GTK3 + WebKit2GTK shell + in-process server + JSON bridge
  web/                  # frontend (reused as-is)
    index.html  app.js  style.css
    scripts/fsrs.js     # FSRS-5 scheduler
    vendor/katex/       # vendored KaTeX (offline, committed)
    decks/*.json        # GENERATED deck data (committed; rebuilt on launch if missing)
    sparring.config.json
  cards/                # SOURCE OF TRUTH: one YAML per card, one deck.yaml per deck
    <deck-slug>/*.yaml
  tools/
    build.py            # cards/**/*.yaml -> web/decks/*.json + refresh config
    mint.py             # scaffold a new card YAML
  docs/
    DESIGN.md           # architecture decisions + roadmap
    BRIDGE.md           # JS↔Python /__api/* protocol (CRUD + persistence)
    PACKAGING.md        # standalone packaging (Tauri chosen)
    FORMAT.md  CONFIG.md  ALGORITHM.md
  packaging/tauri/      # Tauri scaffold for a no-Python standalone binary
```

## Cards: the YAML workflow

The source of truth is **one YAML file per card** under `cards/<deck-slug>/`,
plus a `deck.yaml` per deck. `tools/build.py` compiles them into
`web/decks/<slug>.json` (what the frontend fetches) and refreshes the `decks[]`
array in `web/sparring.config.json`.

```bash
# scaffold a new card, then edit it and rebuild
python3 tools/mint.py demo "Chain rule" --bloco "C — Beyond math"
$EDITOR cards/demo/07-chain-rule.yaml
python3 tools/build.py        # cards -> web/decks/*.json
```

A card YAML: `id` (stable — never change it, it keys FSRS history), `deck`,
`order`, `bloco`, `title`, `hard`, `tags`, `ref`, and the prose block scalars
`front` / `back` / `comments`. See `docs/FORMAT.md`.

`web/decks/*.json` are committed so a fresh clone runs without a build step; the
app also rebuilds them on launch if they're missing (`ensure_decks_built()`).

## Edit mode (create / edit / delete cards in-app)

When you run the **desktop app** (so the Python bridge is up), the study view
shows an **✎ Editar** toggle. In edit mode you can:

- **✎ Editar este** — edit the current card's fields (title, bloco, hard, tags,
  ref, front, back, comments). Saving keeps the card `id` stable.
- **＋ Novo cartão** — create a card (gets a fresh `id = <slug>-<n>`).
- **🗑 Apagar este** — delete the current card.

Each action writes the per-card YAML in `cards/<slug>/` via the bridge and
re-runs `build.py`. In a **plain browser** (no bridge) edit mode stays hidden,
but the editor's **⧉ Copiar YAML** still gives you the YAML to paste by hand.
Protocol: `docs/BRIDGE.md`.

## Data persistence

FSRS state + settings live in `localStorage` (read/write path) **and** are
mirrored to a per-user data dir so they survive a localStorage wipe / reinstall:

- Linux `~/.local/share/sparring/appdata.json`
- Windows `%APPDATA%/sparring/appdata.json`
- macOS `~/Library/Application Support/sparring/appdata.json`

On launch the app hydrates any keys missing from localStorage from that file.
Settings → **Dados** still does manual JSON export/import.

## Packaging (no Python)

`docs/PACKAGING.md` weighs Tauri vs PyInstaller vs Flatpak and picks **Tauri**
(small Rust binary bundling `web/`, system WebKitGTK, zero Python). Scaffold +
build steps in `packaging/tauri/`.

## Status

**Done:** native shell + in-process JSON bridge, KaTeX vendored, per-card YAML +
`build.py`/`mint.py`, comments block, random pull, stale "1 to review" fix
(home badge excludes same-day learning steps, shown separately as "aprendendo"),
in-app card CRUD / edit mode, per-user data-dir persistence, Tauri packaging
scaffold.

**Next (queued):** back-side clipping on very long cards; vendoring Google Fonts
for full offline; a real Tauri binary build. See `docs/DESIGN.md`.
