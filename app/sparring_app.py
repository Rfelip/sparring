#!/usr/bin/env python3
"""
sparring_app.py — native desktop shell for the Sparring spaced-repetition app.

Why this exists
---------------
Sparring used to be a browser page you had to `./serve.sh` and open at
localhost. This wraps the *same* web frontend in a real GTK window via
WebKit2GTK, with a tiny HTTP server started/stopped inside the process.
You click the app; there is no server to run, no tab to find, no file://
fetch breakage. The web/ directory is reused verbatim.

The in-process server also exposes a small JSON BRIDGE under `/__api/` so the
frontend can ask Python to:

  * persist FSRS state + settings to a proper per-user data dir
    (survives repackaging / localStorage wipes), and
  * create / update / delete card YAML on disk and rebuild the deck JSON.

When the page is opened in a plain browser (no Python shell) those endpoints
simply aren't there, and the frontend degrades gracefully (edit mode disabled,
localStorage used for state). See docs/BRIDGE.md for the protocol.

Stack: PyGObject + WebKit2GTK 4.1 (both already installed on Fedora as
`python3-gobject` + `webkit2gtk4.1`). Zero pip, zero network.

Run:  python3 app/sparring_app.py   (or the ./sparring launcher)
"""
from __future__ import annotations

import functools
import http.server
import json
import mimetypes
import os
import re
import subprocess
import sys
import threading
from pathlib import Path

# ── Defensive env: some AMD/Mesa stacks render a black WebKit viewport unless
#    the DMABUF renderer is disabled. Harmless elsewhere. Must be set before
#    WebKit2 is imported.
os.environ.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")

# ── Paths ───────────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
WEB_DECKS = WEB_DIR / "decks"
CARDS_DIR = ROOT / "cards"
BUILD_PY = ROOT / "tools" / "build.py"

# Ensure font MIME types resolve so KaTeX fonts serve cleanly.
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/woff", ".woff")
mimetypes.add_type("font/ttf", ".ttf")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")


# ── Per-user data dir (cross-platform) ───────────────────────────────────────
def user_data_dir() -> Path:
    """Per-user data dir for persisted FSRS state + settings.

      Linux   →  $XDG_DATA_HOME/sparring  or  ~/.local/share/sparring
      Windows →  %APPDATA%/sparring
      macOS   →  ~/Library/Application Support/sparring
    """
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    elif os.name == "nt":
        base = Path(os.environ.get("APPDATA", Path.home()))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    d = base / "sparring"
    d.mkdir(parents=True, exist_ok=True)
    return d


APPDATA_FILE = user_data_dir() / "appdata.json"


def read_appdata() -> dict:
    if APPDATA_FILE.exists():
        try:
            return json.loads(APPDATA_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def write_appdata(obj: dict) -> None:
    # Atomic-ish write so a crash mid-save can't corrupt the file.
    tmp = APPDATA_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(APPDATA_FILE)


# ── Card YAML CRUD ───────────────────────────────────────────────────────────
# We intentionally emit YAML by hand (no PyYAML dependency in the GUI process)
# using the exact block-scalar shape build.py + the docs expect. build.py is run
# as a subprocess afterwards so the cards→JSON compilation contract stays the
# single source of truth — we never write web/decks/*.json directly here.

_SLUG_RE = re.compile(r"[^a-z0-9]+")
_SAFE_SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _slugify(s: str) -> str:
    s = (s or "").lower()
    s = _SLUG_RE.sub("-", s).strip("-")
    return s[:40] or "card"


def _yaml_str(s: str) -> str:
    """Single-line scalar for header fields — quote defensively."""
    s = str(s)
    if s == "" or any(ch in s for ch in ':#{}[],&*!|>%@`"\'') or s != s.strip():
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return s


def _yaml_block(field: str, value: str) -> str:
    """A `field: |` block scalar with 2-space indentation."""
    text = (value or "").rstrip("\n")
    if text == "":
        return f"{field}: |\n  \n"
    lines = text.split("\n")
    body = "\n".join("  " + ln if ln else "" for ln in lines)
    return f"{field}: |\n{body}\n"


def _tags_inline(tags) -> str:
    if not tags:
        return "[]"
    return "[" + ", ".join(_yaml_str(str(t)) for t in tags) + "]"


def render_card_yaml(card: dict) -> str:
    """Render a card dict to the YAML shape build.py reads.

    Keys we care about: id, deck, order, bloco, title, hard, tags, ref,
    front, back, comments. Missing keys default sensibly.
    """
    out = [
        f"id: {_yaml_str(card['id'])}",
        f"deck: {_yaml_str(card['deck'])}",
        f"order: {int(card.get('order', 9999))}",
        f"bloco: {_yaml_str(card.get('bloco', ''))}",
        f"title: {_yaml_str(card.get('title', ''))}",
        f"hard: {'true' if card.get('hard') else 'false'}",
        f"tags: {_tags_inline(card.get('tags', []))}",
        f"ref: {_yaml_str(card.get('ref', ''))}",
    ]
    head = "\n".join(out) + "\n"
    body = (
        _yaml_block("front", card.get("front", ""))
        + _yaml_block("back", card.get("back", ""))
        + _yaml_block("comments", card.get("comments", ""))
    )
    return head + body


def _deck_dir(slug: str) -> Path:
    if not _SAFE_SLUG.match(slug or ""):
        raise ValueError(f"unsafe deck slug: {slug!r}")
    d = (CARDS_DIR / slug).resolve()
    # Guard against path traversal — must resolve directly inside CARDS_DIR.
    if d.parent != CARDS_DIR.resolve():
        raise ValueError("deck path escapes cards/")
    return d


def _existing_card_file(deck_dir: Path, card_id: str) -> Path | None:
    """Find the YAML file whose `id:` matches, scanning the header line only."""
    for cf in deck_dir.glob("*.yaml"):
        if cf.name == "deck.yaml":
            continue
        try:
            for line in cf.read_text(encoding="utf-8").splitlines():
                m = re.match(r"\s*id:\s*(.+?)\s*$", line)
                if m:
                    val = m.group(1).strip().strip('"').strip("'")
                    if val == card_id:
                        return cf
                    break  # id is the first field; stop after we see it
        except Exception:
            continue
    return None


def _next_card_number(deck_dir: Path) -> int:
    nums = []
    for cf in deck_dir.glob("*.yaml"):
        if cf.name == "deck.yaml":
            continue
        m = re.match(r"(\d+)", cf.stem)
        if m:
            nums.append(int(m.group(1)))
        first = cf.read_text(encoding="utf-8").splitlines()[:1]
        if first:
            mi = re.search(r"(\d+)\s*$", first[0])
            if mi and first[0].lstrip().startswith("id:"):
                nums.append(int(mi.group(1)))
    return (max(nums) + 1) if nums else 1


def run_build() -> tuple[bool, str]:
    """Re-run tools/build.py as a subprocess; return (ok, combined output)."""
    try:
        proc = subprocess.run(
            [sys.executable, str(BUILD_PY)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=60,
        )
        out = (proc.stdout or "") + (proc.stderr or "")
        return proc.returncode == 0, out
    except Exception as e:  # noqa: BLE001
        return False, f"build failed: {e}"


def save_card(payload: dict) -> dict:
    """Create or update a card. Keys: deck, id?(update), title, bloco, hard,
    tags, ref, front, back, comments, order?.
    Returns {ok, id, file, build}."""
    slug = payload.get("deck")
    deck_dir = _deck_dir(slug)
    if not (deck_dir / "deck.yaml").exists():
        return {"ok": False, "error": f"no deck at cards/{slug}/deck.yaml"}

    card_id = payload.get("id")
    if card_id:
        # UPDATE — keep id stable, overwrite the existing file in place.
        existing = _existing_card_file(deck_dir, card_id)
        if existing is None:
            # id given but no matching file → create with that id.
            n = _next_card_number(deck_dir)
            target = deck_dir / f"{n:02d}-{_slugify(payload.get('title', card_id))}.yaml"
            order = payload.get("order", n * 10)
        else:
            target = existing
            order = payload.get("order")
            if order is None:
                m = re.search(r"^order:\s*(\d+)", existing.read_text(encoding="utf-8"), re.M)
                order = int(m.group(1)) if m else 9999
    else:
        # CREATE — new id = <slug>-<n>.
        n = _next_card_number(deck_dir)
        card_id = f"{slug}-{n}"
        target = deck_dir / f"{n:02d}-{_slugify(payload.get('title', 'card'))}.yaml"
        order = payload.get("order", n * 10)

    card = {
        "id": card_id,
        "deck": slug,
        "order": order,
        "bloco": payload.get("bloco", ""),
        "title": payload.get("title", ""),
        "hard": bool(payload.get("hard", False)),
        "tags": payload.get("tags", []) or [],
        "ref": payload.get("ref", ""),
        "front": payload.get("front", ""),
        "back": payload.get("back", ""),
        "comments": payload.get("comments", ""),
    }
    target.write_text(render_card_yaml(card), encoding="utf-8")
    ok, out = run_build()
    return {"ok": ok, "id": card_id, "file": str(target.relative_to(ROOT)), "build": out}


def delete_card(payload: dict) -> dict:
    """Delete a card by id within a deck. Keys: deck, id. Returns {ok, ...}."""
    slug = payload.get("deck")
    deck_dir = _deck_dir(slug)
    card_id = payload.get("id")
    if not card_id:
        return {"ok": False, "error": "missing id"}
    existing = _existing_card_file(deck_dir, card_id)
    if existing is None:
        return {"ok": False, "error": f"card {card_id} not found"}
    existing.unlink()
    ok, out = run_build()
    return {"ok": ok, "id": card_id, "build": out}


import gi  # noqa: E402

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2, GLib  # noqa: E402


# ── In-process static server + JSON bridge ───────────────────────────────────
class _Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):  # silence per-request logging
        pass

    # ── helpers ──
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    # ── routing ──
    def do_GET(self):
        if self.path.startswith("/__api/"):
            return self._handle_api_get()
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/__api/"):
            return self._handle_api_post()
        self.send_error(405)

    def _handle_api_get(self):
        route = self.path.split("?", 1)[0]
        try:
            if route == "/__api/ping":
                return self._json({"ok": True, "bridge": "sparring", "version": 1,
                                   "root": str(ROOT)})
            if route == "/__api/appdata":
                return self._json({"ok": True, "data": read_appdata()})
            return self._json({"ok": False, "error": "unknown route"}, 404)
        except Exception as e:  # noqa: BLE001
            return self._json({"ok": False, "error": str(e)}, 500)

    def _handle_api_post(self):
        route = self.path.split("?", 1)[0]
        try:
            payload = self._read_body()
            if route == "/__api/appdata":
                write_appdata(payload if isinstance(payload, dict) else {})
                return self._json({"ok": True})
            if route == "/__api/card/save":
                return self._json(save_card(payload))
            if route == "/__api/card/delete":
                return self._json(delete_card(payload))
            return self._json({"ok": False, "error": "unknown route"}, 404)
        except Exception as e:  # noqa: BLE001
            return self._json({"ok": False, "error": str(e)}, 500)


# A *stable* port keeps the page origin constant across launches — which is what
# keeps localStorage (your FSRS review history) from resetting every time. A random
# port would give a new origin each run and silently wipe your progress.
PREFERRED_PORT = 47817


def start_server(web_dir: Path, port: int = PREFERRED_PORT):
    handler = functools.partial(_Handler, directory=str(web_dir))
    try:
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    except OSError:
        # Port busy (a second instance?). Fall back to ephemeral so the app still
        # opens — note storage won't share origin with the stable-port instance.
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    used = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, used


def ensure_decks_built():
    """If web/decks/ is empty/missing (e.g. fresh checkout, build-on-launch),
    compile the YAML once so the app has something to load."""
    if not CARDS_DIR.is_dir():
        return
    have_json = WEB_DECKS.is_dir() and any(WEB_DECKS.glob("*.json"))
    have_yaml = any(CARDS_DIR.glob("*/deck.yaml"))
    if have_yaml and not have_json:
        sys.stdout.write("[sparring] web/decks/ missing — running build.py…\n")
        ok, out = run_build()
        if not ok:
            sys.stderr.write(out + "\n")


# ── GTK window ───────────────────────────────────────────────────────────────
class SparringWindow(Gtk.Window):
    def __init__(self, url: str, httpd):
        super().__init__(title="Sparring")
        self._httpd = httpd
        self.set_default_size(960, 860)
        self.set_position(Gtk.WindowPosition.CENTER)
        try:
            self.set_icon_name("accessories-dictionary")  # themed fallback icon
        except Exception:
            pass

        # Persistent WebKit storage so localStorage (legacy FSRS history) survives
        # across launches. With the stable port above, the page origin stays
        # constant. (Authoritative state now also mirrors to the per-user data dir
        # via the /__api/appdata bridge — see user_data_dir().)
        data_dir = Path(GLib.get_user_data_dir()) / "sparring"
        cache_dir = Path(GLib.get_user_cache_dir()) / "sparring"
        data_dir.mkdir(parents=True, exist_ok=True)
        cache_dir.mkdir(parents=True, exist_ok=True)
        data_mgr = WebKit2.WebsiteDataManager(
            base_data_directory=str(data_dir),
            base_cache_directory=str(cache_dir),
        )
        ctx = WebKit2.WebContext.new_with_website_data_manager(data_mgr)
        self.webview = WebKit2.WebView.new_with_context(ctx)

        settings = self.webview.get_settings()
        settings.set_enable_developer_extras(True)      # right-click → Inspect
        settings.set_enable_smooth_scrolling(True)
        settings.set_javascript_can_access_clipboard(True)

        self.add(self.webview)
        self.webview.load_uri(url)

        self.connect("destroy", self._on_destroy)
        self.connect("key-press-event", self._on_key)

    def _on_key(self, _w, event):
        from gi.repository import Gdk
        ctrl = event.state & Gdk.ModifierType.CONTROL_MASK
        if ctrl and event.keyval in (Gdk.KEY_q, Gdk.KEY_Q):
            self.close()
            return True
        if ctrl and event.keyval in (Gdk.KEY_r, Gdk.KEY_R):
            self.webview.reload()
            return True
        if event.keyval == Gdk.KEY_F11:
            if self.get_window().get_state() & Gdk.WindowState.FULLSCREEN:
                self.unfullscreen()
            else:
                self.fullscreen()
            return True
        return False

    def _on_destroy(self, *_a):
        try:
            self._httpd.shutdown()
        except Exception:
            pass
        Gtk.main_quit()


def main() -> int:
    if not WEB_DIR.is_dir():
        sys.stderr.write(f"[sparring] web/ not found at {WEB_DIR}\n")
        return 1
    ensure_decks_built()
    httpd, port = start_server(WEB_DIR)
    url = f"http://127.0.0.1:{port}/"
    sys.stdout.write(f"[sparring] serving {WEB_DIR} at {url}\n")
    sys.stdout.write(f"[sparring] app data: {APPDATA_FILE}\n")
    sys.stdout.flush()
    win = SparringWindow(url, httpd)
    win.show_all()
    Gtk.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
