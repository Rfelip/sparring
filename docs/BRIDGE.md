# Sparring — JS ↔ Python bridge

The native shell (`app/sparring_app.py`) runs an in-process loopback HTTP server
on stable port **47817** that serves `web/` AND exposes a small JSON API under
**`/__api/`**. The frontend (`web/app.js`) talks to it via `fetch()`.

When the page is opened in a plain browser (no Python shell), `/__api/*` returns
404 and the frontend degrades gracefully:

- **State** stays in `localStorage` only (no data-dir mirror).
- **Edit mode** stays hidden; the card editor can still render a card's YAML and
  offer **"Copy YAML"** as a manual fallback.

Detection: `app.js` calls `GET /__api/ping` once at boot (`Bridge.probe()`).
`Bridge.available` gates every bridge feature.

## Endpoints

All request/response bodies are JSON (`Content-Type: application/json`). Every
response has an `ok: boolean`; errors add `error: string` and an HTTP 4xx/5xx.

### `GET /__api/ping`
Liveness + identity probe.
```json
{ "ok": true, "bridge": "sparring", "version": 1, "root": "/home/.../sparring" }
```

### `GET /__api/appdata`
Returns the persisted app-data blob (FSRS state + settings mirror).
```json
{ "ok": true, "data": { "version": 1, "localStorage": { "<key>": "<json-string>" } } }
```

### `POST /__api/appdata`
Overwrites the app-data blob. The frontend posts a snapshot of every
`sparring:*` localStorage key after each rating / settings change (debounced
~400ms). Stored atomically to the per-user data dir (see **Persistence**).
```json
{ "version": 1, "localStorage": { "sparring:state:demo": "{...}", "...": "..." } }
```
→ `{ "ok": true }`

### `POST /__api/card/save`
Create or update a card's YAML in `cards/<deck>/`, then re-run `tools/build.py`
so `web/decks/<deck>.json` + `web/sparring.config.json` are regenerated.

Request:
```json
{
  "deck":     "demo",        // required, deck slug
  "id":       "demo-3",      // OPTIONAL: present = UPDATE (id stays stable);
                                  //           absent  = CREATE (new id = <deck>-<n>)
  "title":    "Bayes' theorem",
  "bloco":    "A — Definição",
  "ref":      "§3",
  "tags":     ["definicao"],
  "hard":     false,
  "front":    "markdown + $LaTeX$",
  "back":     "...",
  "comments": "..."
}
```
Response:
```json
{ "ok": true, "id": "demo-3", "file": "cards/demo/03-....yaml", "build": "<build.py log>" }
```

- **CREATE** allocates the next free number `<n>` (max of existing card numbers + 1),
  writes `cards/<deck>/<NN>-<title-slug>.yaml`, and assigns `id = <deck>-<n>`.
- **UPDATE** finds the file whose `id:` header matches and overwrites it **in place**,
  preserving the file name, `id`, and existing `order` (unless overridden). This is
  what keeps FSRS history attached to the card across edits.
- Front and back are required (the build skips cards missing either).

### `POST /__api/card/delete`
```json
{ "deck": "demo", "id": "demo-3" }
```
→ `{ "ok": true, "id": "demo-3", "build": "<build.py log>" }`

Removes the matching YAML file and rebuilds. The deck JSON is left in place (now
with one fewer card); if the deck still has cards it stays in the config.

## Safety

- Deck slugs are validated against `^[A-Za-z0-9][A-Za-z0-9._-]*$` and the
  resolved deck dir must sit **directly** inside `cards/` — blocks `../` traversal.
- The GUI process writes YAML by hand (no PyYAML dep) in the exact block-scalar
  shape `tools/build.py` reads, then shells out to `build.py` as the single
  source of truth for the cards→JSON compilation. The shell never writes
  `web/decks/*.json` directly.

## Persistence (per-user data dir)

`appdata.json` lives in an OS-appropriate per-user data dir, so progress survives
re-packaging / reinstall / a localStorage wipe:

| OS | Path |
|---|---|
| Linux | `$XDG_DATA_HOME/sparring/appdata.json` or `~/.local/share/sparring/appdata.json` |
| Windows | `%APPDATA%/sparring/appdata.json` |
| macOS | `~/Library/Application Support/sparring/appdata.json` |

Flow:
1. **Boot** — `Bridge.probe()`; if up, `hydrateFromAppData()` copies any keys
   present in `appdata.json` but **missing** from localStorage (never clobbers
   newer in-browser state).
2. **Live** — localStorage is the store the UI reads/writes.
3. **Mirror** — after each `saveState` / `saveCaps` / `saveActivity` / `applyTheme`,
   a debounced `POST /__api/appdata` writes the full snapshot to disk.

Import/Export (Settings → Dados) still works as before and is independent of the
bridge — it round-trips the same `sparring:state:*` keys as a downloadable JSON.
