# Sparring — design notes & roadmap

## ADR 1 — Native shell via GTK3 + WebKit2GTK (not a browser, not Electron)

**Context.** Sparring's UI is a polished HTML/CSS/JS app with KaTeX math. The goal was for it to be "its own thing" — a real app you click, with no server to start.

**Decision.** Wrap the existing web frontend in a native **GTK3 window with an
embedded WebKit2GTK 4.1 webview** (`app/sparring_app.py`), and serve the bundled
`web/` over a **loopback HTTP server started inside the process** on a stable
port. The window and the server live and die together. The frontend is reused
verbatim — no rewrite.

**Why this over the alternatives:**

| Option | Verdict |
|---|---|
| **GTK3 + WebKit2GTK** | ✅ Chosen. Already installed on this machine (`python3-gobject`, `webkit2gtk4.1`). Zero pip, zero network. Reuses 100% of the UI + vendored KaTeX. Real native window. |
| Tauri (Rust) | Best *distributable binary*, tiny. But needs `tauri-cli` + a cold Rust build + `webkit2gtk-devel`. Deferred — good "ship a real binary" upgrade later; the `web/` frontend ports directly. |
| Electron | Dead simple, but ~150 MB and a second Chromium. Rejected on bloat. |
| PySide6 / PyQt (QtWebEngine) | Qt WebEngine is installed but the Python bindings aren't (~200 MB pip). More deps than GTK for no gain. |
| pywebview | Just a thin wrapper over the same WebKit2GTK we use directly. Extra dep, no benefit. |

**Why loopback HTTP and not `file://` or a custom scheme.** The frontend uses
`fetch()` and ES modules, which break under `file://`. A custom `app://` scheme
works but has MIME/CORS sharp edges. An in-process `ThreadingHTTPServer` bound to
`127.0.0.1` reuses the existing fetch-based code unchanged and is invisible to the
user — it solves "I don't want to serve it" without touching the frontend.

**Why a *stable* port (47817), not an ephemeral one.** localStorage — where the
FSRS review history lives — is keyed by page origin (scheme + host + **port**). A
random port each launch would be a new origin and would silently wipe progress.
Fixed port → constant origin → history persists. Storage is also pinned to a
persistent `WebsiteDataManager` under `~/.local/share/sparring`.

**Defensive note (AMD/Mesa).** WebKit2GTK can render a black viewport on some
AMD stacks; `WEBKIT_DISABLE_DMABUF_RENDERER=1` is set in the launcher and the app
before WebKit import. This machine runs an RX 9070 XT (RDNA4), so this is precautionary.

**Status:** built + server-side smoke-tested (GTK3+WebKit2GTK import clean; all
assets serve 200). Visual render on Wayland pending a first launch on a real GUI session — the one
thing not verifiable headless.

---

## ADR 2 — Card format: one YAML file per card (approved, not yet built)

**Decision.** Move from one markdown file per deck to **one YAML file per card**,
tagged with the deck it belongs to. Cards become first-class: reorderable,
retaggable, reusable across decks, clean git diffs, Obsidian-native. A `mint.py`
helper scaffolds a new card so mid-tutoring minting stays one command.

**Shape:**

```yaml
# cards/demo/demo-card.yaml
id: demo-card
deck: cap3                 # the deck tag (a card may later list several)
order: 10
bloco: "A — Definição"
title: Bayes' theorem
hard: false
tags: [definicao]
ref: "§3"
front: |
  ...markdown + $LaTeX$...
back: |
  ...
comments: |               # NEW — rendered as a separate block AFTER the back
  (Erro de hoje: ...)      # context/notes/spoilers live here, never in the title
```

Deck-level metadata (name, color, icon) lives in `cards/decks.yaml`.
`tools/build.py` globs `cards/**/*.yaml`, groups by `deck`, and emits the same
`web/decks/<slug>.json` schema the frontend already consumes (plus `comments`),
and refreshes the `decks` array in `web/sparring.config.json`. The frontend's
loader does not change.

---

## Bug / polish backlog (from 2026-05-29 review)

- [x] **KaTeX not rendering** — was CDN + SRI; now vendored at `web/vendor/katex`.
- [x] **Random pull** — study queue is shuffled (Fisher–Yates) instead of
      due-date/file order. Caps + overdue priority still pick *which* cards.
- [ ] **Comments block** — render `comments` under the back face, visually
      distinct, only after flip. Move all parenthetical "(Erro de hoje…)" notes
      out of `back` and out of titles into this field.
- [x] **Stale "1 to review"** — fixed. `getDueCounts` now uses `isHomeDue`: a
      card counts toward the home "due" badge only if it's brand-new OR a genuine
      review (`state===REVIEW`/not a sub-day learning step) whose `due ≤ now`.
      Same-day LEARNING/RELEARNING cards with `scheduled_days < 1` are tallied
      separately as **`learning` / "aprendendo"** (shown as a distinct badge +
      `(+N aprendendo)` on the status line). Scheduling and in-session queueing
      (`buildQueue`) are unchanged — learning cards still resurface in a session.
- [ ] **Back-side clipping** — long backs overflow the fixed-height flip card
      (`.flashcard` min-height 340px, faces `position:absolute; inset:0;
      overflow:hidden`; inner `.flashcard-text` has `overflow-y:auto` but the box
      doesn't grow). Fix: let the card grow with the visible face, or give the
      back a clear max-height + visible scroll. cap3 Card 1 / Card 5 trigger it.
- [ ] **Content fixes (cap3 deck):** split Card 1 (definition vs. "why ∞ in the
      codomain"); de-spoiler the titles of Card 2 ("padding com ∅") and Card 5
      (hypothesis + counterexample); state index `n,k ∈ ℕ` explicitly; rewrite
      Card 2's answer less mechanically.

---

## ADR 3 — JS↔Python bridge for in-app CRUD + persistence

**Context.** The frontend needed to (a) let the user create/edit/delete cards
without leaving the app, and (b) persist FSRS state somewhere sturdier than
WebKit localStorage (which a repackage/reinstall can wipe).

**Decision.** Extend the in-process loopback server with a small JSON API under
`/__api/` (full protocol in `docs/BRIDGE.md`):

- `card/save` + `card/delete` write per-card YAML in `cards/<slug>/` (the GUI
  process emits YAML by hand in build.py's exact shape, then shells out to
  `build.py` so the cards→JSON compile stays single-sourced) and rebuild.
- `appdata` GET/POST mirror the full localStorage snapshot to a per-user data
  dir (`~/.local/share/sparring/appdata.json` etc.). On boot the app hydrates
  any keys missing locally; on every save it debounce-mirrors back.

**Why a same-origin `fetch` API over `webkit.messageHandlers` or a custom
scheme.** The frontend already speaks `fetch()` to the loopback server. Reusing
it means the bridge is just two more routes, works identically headless for
testing, and the frontend's `Bridge` abstraction degrades to "404 → feature off"
with zero special-casing. `messageHandlers` would couple the JS to WebKit;
a custom scheme reintroduces MIME/CORS edges.

**Graceful degradation.** `Bridge.probe()` (`GET /__api/ping`) gates everything.
In a plain browser the edit toggle is hidden and state stays in localStorage; the
editor still offers **Copy YAML** as a manual fallback.

**Status:** built + bridge endpoints tested headless (ping/appdata round-trip,
card create/update-id-stable/delete, build re-run, path-traversal guard). Legacy
decks not rebuilt from `cards/` are preserved through rebuilds.

---

## Later

- [x] **Card CRUD / edit mode** — done (ADR 3).
- [x] **App-data persistence to a per-user data dir** — done (ADR 3).
- [ ] **Back-side clipping** — long backs still overflow the fixed-height flip
      card. Let the card grow with the visible face, or give the back a clear
      max-height + visible scroll. cap3 Card 1 / Card 5 trigger it.
- Tauri build for a real distributable binary — config + build script scaffolded
  under `packaging/tauri/`, decision recorded in `docs/PACKAGING.md`. (`web/`
  ports directly; bridge transport swaps `fetch` → `invoke`.)
- Vendor the Google Fonts (Lora/Inter) for full offline (graceful fallback today).
- Public cabinet / own git remote if it graduates past personal use.
