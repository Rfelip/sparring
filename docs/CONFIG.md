# Configuration Reference

Sparring is configured via a single JSON file: `sparring.config.json` in the repo root (or the directory you serve from).

If the file is absent, all defaults apply.

---

## Full Schema

```json
{
  "version": 1,

  "decks": [
    {
      "slug": "demo",
      "name": "Demo — Spaced Repetition Basics",
      "path": "decks/sparring-deck-demo.md",
      "color": "#4A6FA5",
      "icon": "∫",
      "tags": ["demo", "sparring"],
      "enabled": true
    },
    {
      "slug": "otim",
      "name": "Otimização Convexa",
      "path": "decks/sparring-deck-physics.md",
      "color": "#2E7D55",
      "icon": "⊆",
      "tags": ["physics", "mechanics"],
      "enabled": true
    }
  ],

  "schedule": {
    "new_cards_per_day": 10,
    "review_cap_per_day": 50,
    "learn_ahead_minutes": 20,
    "timezone": "America/Sao_Paulo"
  },

  "fsrs": {
    "desired_retention": 0.90,
    "maximum_interval": 36500,
    "w": null
  },

  "ui": {
    "theme": "lamp",
    "language": "pt",
    "show_card_id": true,
    "show_ref": true,
    "show_hint_button": true,
    "show_bloco": true,
    "rating_labels": {
      "again": "De novo",
      "hard": "Difícil",
      "good": "Bom",
      "easy": "Fácil"
    },
    "keyboard_shortcuts": {
      "flip": "Space",
      "again": "1",
      "hard": "2",
      "good": "3",
      "easy": "4"
    }
  },

  "export": {
    "auto_backup": false,
    "backup_format": "json"
  }
}
```

---

## Field Reference

### `decks[]`

| Field     | Type    | Default  | Description                                                  |
|-----------|---------|----------|--------------------------------------------------------------|
| `slug`    | string  | required | Short identifier. Used in URLs and state keys.               |
| `name`    | string  | required | Human-readable deck name, shown in the UI.                   |
| `path`    | string  | required | Path to the `.md` deck file, relative to config.             |
| `color`   | string  | `#555`   | CSS hex color used as the deck's accent in the UI.           |
| `icon`    | string  | `📚`     | Single character or emoji shown next to the deck name.       |
| `tags`    | array   | `[]`     | Deck-level tags for filtering.                               |
| `enabled` | boolean | `true`   | Set `false` to hide a deck without deleting it.              |

### `schedule`

| Field                  | Type    | Default | Description                                             |
|------------------------|---------|---------|---------------------------------------------------------|
| `new_cards_per_day`    | integer | 10      | Max new (never-seen) cards introduced per day.          |
| `review_cap_per_day`   | integer | 50      | Max reviews per day (across all decks combined).        |
| `learn_ahead_minutes`  | integer | 20      | Show cards due within N minutes as if they were due.    |
| `timezone`             | string  | system  | IANA timezone for day boundary calculations.            |

### `fsrs`

| Field               | Type         | Default | Description                                                    |
|---------------------|--------------|---------|----------------------------------------------------------------|
| `desired_retention` | float        | 0.90    | Target retention probability (0.70–0.97 recommended).         |
| `maximum_interval`  | integer      | 36500   | Max scheduling interval in days (default = 100 years).        |
| `w`                 | array/null   | null    | 19-element FSRS-5 weight vector. `null` uses global defaults. |

### `ui`

| Field               | Type    | Default | Description                                                        |
|---------------------|---------|---------|--------------------------------------------------------------------|
| `theme`             | string  | `lamp`  | Color theme. See [DESIGN.md](DESIGN.md) for available themes.      |
| `language`          | string  | `pt`    | `pt` (Portuguese) or `en` (English) for UI labels.                |
| `show_card_id`      | boolean | `true`  | Show "Card N" label on the card face.                              |
| `show_ref`          | boolean | `true`  | Show the reference field (Source/Chapter ref) below the back.      |
| `show_hint_button`  | boolean | `true`  | Show a "Hint" button during review (only if card has a hint).      |
| `show_bloco`        | boolean | `true`  | Show the bloco/topic label on the card.                            |
| `rating_labels`     | object  | (PT)    | Override the label text for each rating button.                    |
| `keyboard_shortcuts`| object  | (below) | Key bindings for review actions.                                   |

#### Default keyboard shortcuts

| Action | Key     |
|--------|---------|
| Flip   | `Space` |
| Again  | `1`     |
| Hard   | `2`     |
| Good   | `3`     |
| Easy   | `4`     |

### `export`

| Field           | Type    | Default | Description                                       |
|-----------------|---------|---------|---------------------------------------------------|
| `auto_backup`   | boolean | `false` | Reserved — not yet implemented.                   |
| `backup_format` | string  | `json`  | Format for manual export: `json` or `csv`.        |

---

## Themes

| Value   | Description                              |
|---------|------------------------------------------|
| `lamp`  | Warm cream + ink-blue (default)          |
| `felt`  | Green felt library aesthetic             |
| `dark`  | Dark mode (low-light study)              |
| `sepia` | Aged paper tone                          |

Custom palettes can be injected via `--theme-*` CSS custom properties in a linked stylesheet. See [DESIGN.md](DESIGN.md).

---

## Minimal Config Example

```json
{
  "version": 1,
  "decks": [
    { "slug": "demo", "name": "Demo", "path": "decks/sparring-deck-demo.md" }
  ]
}
```

All other values take defaults.

---

## Config Loading

The web app loads config from `./sparring.config.json` relative to `index.html`. If the fetch fails (e.g. file:// protocol without a server), it falls back to a hardcoded default config that expects deck files to be pre-converted to JSON and placed in `decks/<slug>.json`.

When serving locally via `serve.sh`, the config file is picked up automatically.
