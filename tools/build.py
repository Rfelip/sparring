#!/usr/bin/env python3
"""
build.py — compile per-card YAML into the deck JSON the web app reads.

Source of truth:  cards/<deck-slug>/deck.yaml   (deck metadata)
                  cards/<deck-slug>/*.yaml       (one file per card)
Output:           web/decks/<slug>.json          (one per deck)
                  web/sparring.config.json        (decks[] array refreshed)

A card YAML:
    id: demo-1        # stable — keep it constant to preserve FSRS history
    deck: demo
    order: 10              # sort key within the deck
    bloco: "A — Definição" # optional grouping (label shown + filter key)
    title: "Bayes' theorem"
    hard: false
    tags: [definicao]
    ref: "§3"
    front: |
      ... markdown + $LaTeX$ ...
    back: |
      ...
    comments: |            # rendered as a SEPARATE card after the answer
      ...

Run:  python3 tools/build.py
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CARDS = ROOT / "cards"
WEB_DECKS = ROOT / "web" / "decks"
CONFIG = ROOT / "web" / "sparring.config.json"


def topic_of(bloco: str) -> str:
    """'A — Fundações' -> 'Fundações'; otherwise the whole label."""
    if not bloco:
        return ""
    for sep in (" — ", " - ", "—"):
        if sep in bloco:
            return bloco.split(sep, 1)[1].strip()
    return bloco


def build_deck(deck_dir: Path):
    meta_path = deck_dir / "deck.yaml"
    if not meta_path.exists():
        return None
    meta = yaml.safe_load(meta_path.read_text(encoding="utf-8")) or {}
    slug = meta["slug"]

    cards = []
    for cf in sorted(deck_dir.glob("*.yaml")):
        if cf.name == "deck.yaml":
            continue
        c = yaml.safe_load(cf.read_text(encoding="utf-8")) or {}
        if not c.get("front") or not c.get("back"):
            print(f"  [warn] {cf.name}: missing front/back — skipped", file=sys.stderr)
            continue
        ref = str(c.get("ref", "")).strip()
        cards.append({
            "id":       c.get("id") or f"{slug}-{cf.stem}",
            "num":      str(c.get("order", "")),
            "title":    c.get("title", ""),
            "topic":    topic_of(c.get("bloco", "")),
            "bloco":    c.get("bloco", ""),
            "hard":     bool(c.get("hard", False)),
            "tags":     c.get("tags", []) or [],
            "refs":     [{"label": "", "value": ref}] if ref else [],
            "front":    str(c["front"]).rstrip("\n"),
            "back":     str(c["back"]).rstrip("\n"),
            "comments": str(c.get("comments", "")).rstrip("\n"),
            "_order":   c.get("order", 9999),
        })

    cards.sort(key=lambda x: (x["_order"], x["id"]))
    for c in cards:
        del c["_order"]

    deck_json = {
        "meta": {
            "source_file": f"cards/{deck_dir.name}/",
            "slug":        slug,
            "created":     str(meta.get("created", "")),
            "tags":        meta.get("tags", []),
            "status":      meta.get("status", "active"),
            "source":      meta.get("source", ""),
            "card_count":  len(cards),
            "color":       meta.get("color", ""),
            "lang":        meta.get("lang", "pt"),
        },
        "cards": cards,
    }
    return meta, deck_json


def main() -> int:
    WEB_DECKS.mkdir(parents=True, exist_ok=True)
    if not CARDS.is_dir():
        print(f"[error] no cards/ dir at {CARDS}", file=sys.stderr)
        return 1

    built: dict[str, dict] = {}  # slug -> deck meta
    for deck_dir in sorted(p for p in CARDS.iterdir() if p.is_dir()):
        res = build_deck(deck_dir)
        if not res:
            continue
        meta, deck_json = res
        slug = meta["slug"]
        out = WEB_DECKS / f"{slug}.json"
        out.write_text(json.dumps(deck_json, ensure_ascii=False, indent=2), encoding="utf-8")
        built[slug] = meta
        print(f"  {slug}: {deck_json['meta']['card_count']} cards -> {out.relative_to(ROOT)}",
              file=sys.stderr)

    if not built:
        print("  [warn] no decks built (no cards/<slug>/deck.yaml found)", file=sys.stderr)
        return 0

    # Refresh config decks[] — rebuild the ones we own, preserve any legacy others.
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    existing = cfg.get("decks", [])
    built_entries = []
    for slug, meta in sorted(built.items(), key=lambda kv: kv[1].get("order", 999)):
        built_entries.append({
            "slug":    slug,
            "name":    meta.get("name", slug),
            "path":    f"cards/{slug}/",
            "color":   meta.get("color", ""),
            "icon":    meta.get("icon", ""),
            "tags":    meta.get("tags", []),
            "enabled": meta.get("enabled", True),
        })
    legacy = [e for e in existing if e.get("slug") not in built]
    cfg["decks"] = built_entries + legacy
    CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  config: {len(built_entries)} built + {len(legacy)} legacy decks", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
