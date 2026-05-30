#!/usr/bin/env python3
"""
mint.py — scaffold a new card YAML so minting one mid-session stays one command.

Usage:
  python3 tools/mint.py <deck-slug> "Card title" [--bloco "A — X"] [--ref "§3"] [--hard]

Creates cards/<deck-slug>/<NN>-<slug>.yaml with the next id/order, then prints
the path. Open it, fill front/back/comments, and run tools/build.py.
"""
from __future__ import annotations
import argparse
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CARDS = ROOT / "cards"


def slugify(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:40] or "card"


def main() -> int:
    ap = argparse.ArgumentParser(description="Scaffold a new Sparring card YAML.")
    ap.add_argument("deck", help="deck slug, e.g. demo")
    ap.add_argument("title", help="card title")
    ap.add_argument("--bloco", default="", help='grouping label, e.g. "A — Definição"')
    ap.add_argument("--ref", default="", help='source ref, e.g. "§3"')
    ap.add_argument("--hard", action="store_true", help="mark as a hard card")
    args = ap.parse_args()

    deck_dir = CARDS / args.deck
    if not (deck_dir / "deck.yaml").exists():
        print(f"[error] no deck at cards/{args.deck}/deck.yaml — create the deck first.",
              file=sys.stderr)
        return 1

    # Next order/id: max numeric suffix among existing card ids + 1.
    nums = []
    for cf in deck_dir.glob("*.yaml"):
        if cf.name == "deck.yaml":
            continue
        data = yaml.safe_load(cf.read_text(encoding="utf-8")) or {}
        m = re.search(r"(\d+)$", str(data.get("id", "")))
        if m:
            nums.append(int(m.group(1)))
        m2 = re.match(r"(\d+)", cf.stem)
        if m2:
            nums.append(int(m2.group(1)))
    n = (max(nums) + 1) if nums else 1

    card_id = f"{args.deck}-{n}"
    fname = f"{n:02d}-{slugify(args.title)}.yaml"
    path = deck_dir / fname
    if path.exists():
        print(f"[error] {path} already exists", file=sys.stderr)
        return 1

    card = {
        "id": card_id,
        "deck": args.deck,
        "order": n * 10,
        "bloco": args.bloco,
        "title": args.title,
        "hard": args.hard,
        "tags": [],
        "ref": args.ref,
        "front": "TODO\n",
        "back": "TODO\n",
        "comments": "",
    }
    # Emit with block scalars for the prose fields for easy editing.
    head = {k: card[k] for k in ("id", "deck", "order", "bloco", "title", "hard", "tags", "ref")}
    body = yaml.safe_dump(head, allow_unicode=True, sort_keys=False, default_flow_style=False)
    body += "front: |\n  TODO\nback: |\n  TODO\ncomments: |\n  \n"
    path.write_text(body, encoding="utf-8")
    print(str(path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
