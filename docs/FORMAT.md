# Sparring Deck Format Specification

Version: 1.0  
Status: Canonical

---

## Overview

Sparring decks are plain Markdown files that a parser converts to structured card data. The format is human-readable, diff-friendly, and compatible with standard Markdown renderers (Obsidian, GitHub, VSCode).

---

## File Structure

```
<YAML frontmatter>
# Title

optional prose intro

---

## Bloco A — Topic Name

### Card N — Card Title [OPTIONAL-TAG]
**Front:** question text, may span multiple lines
**Back:** answer text, may span multiple lines
**Source ref:** §N  (or any "ref" field)

---

### Card N+1 — ...

## Bloco B — Another Topic

...

## Hard — Harder Cards (optional section)

### Hard-N — Card Title
...
```

---

## YAML Frontmatter

All fields are optional but recommended. The parser reads them to populate deck metadata.

```yaml
---
created: YYYY-MM-DD          # ISO date, when the deck was created
tags: [tag1, tag2]           # free list; used for filtering
status: active | archived    # active = include in review queue
card_count: 72               # informational; parser re-counts anyway
source: "Author, Book Title" # the primary reference for the deck
theme_color: "#4A6FA5"       # optional accent color for this deck in the UI
lang: pt | en                # deck language; defaults to pt
---
```

---

## Structural Elements

### Bloco Headers

```markdown
## Bloco A — Topic Name
## Bloco B — Another Topic
## Bloco 1 — Topic Name   (numeric label also valid)
```

- Prefix `## Bloco <label>` is required; the label can be a letter or number.
- Everything between the `## Bloco` line and the next `## Bloco` (or end of file) belongs to this bloco.
- The topic name (after `—` or `-`) becomes the `topic` field on every card in that bloco.

### Hard Section

```markdown
## Hard — Difficulty Label
```

Any `## Hard` heading (case-insensitive, any suffix) marks the start of a harder sub-deck. Cards under it get `"hard": true` in the parsed output. There can be at most one Hard section per file; convention is to place it at the end.

Hard cards use the same `### Hard-N — Title` pattern for their headers:

```markdown
### Hard-1 — Card Title
```

---

## Card Headers

```markdown
### Card N — Title [TAG]
```

- `N` is the card number within the deck. May include a letter suffix (e.g. `3a`, `3b`) for sub-cards.
- The separator between number and title is `—` (em dash) or `-` (hyphen); both are accepted.
- `[TAG]` is an optional bracket annotation at the end of the title. Multiple tags are comma-separated: `[OWN,HARD]`. Known tags:

| Tag    | Meaning                                               |
|--------|-------------------------------------------------------|
| OWN    | Card you authored (not from the source reference)     |
| HARD   | Flagged as hard within a normal bloco                 |
| REVIEW | Flagged for targeted review                           |
| SKIP   | Exclude from review queue entirely                    |

Tags are case-insensitive in the parser.

---

## Card Fields

### Front (required)

```markdown
**Front:** Single-line question
```

```markdown
**Front:** Question that continues
on the next line and the line after.
Additional continuation lines are included
until the next `**...**:` field or `### Card` header.
```

The front is the question / prompt shown before the card is flipped.

### Back (required)

```markdown
**Back:** Answer text.
Continuation lines work the same as Front.
$$\int_X f \, d\mu = \lim_{n \to \infty} \int_X f_n \, d\mu$$
```

The back is the answer / explanation revealed after flipping.

### Ref Fields (optional)

```markdown
**Source ref:** §4
**Chapter ref:** §2.3
**Ref:** Folland p. 47
```

Any field of the form `**<word> ref:**` is treated as a reference. The label (e.g. "Source", "Chapter") is stored alongside the value. Multiple ref fields per card are allowed.

### Hint (optional)

```markdown
**Hint:** Think about monotone convergence.
```

A hint shown on demand (not revealed automatically with the back).

### Tags (optional inline field)

```markdown
**Tags:** convergence, integral, key
```

Per-card tags for filtering within the UI.

---

## LaTeX Support

Inline and block LaTeX is supported throughout Front and Back fields.

- **Inline:** `$f: X \to \mathbb{R}$`
- **Block:**
  ```
  $$
  \int_X f \, d\mu \geq 0
  $$
  ```

The parser preserves LaTeX strings verbatim; the web app uses KaTeX for rendering.

---

## Multi-line Field Rules

A field value continues on subsequent lines until:
1. A new `**FieldName:**` line is encountered, OR
2. A new `### Card` or `### Hard-` header is encountered, OR
3. A horizontal rule `---` is encountered.

Blank lines within a multi-line field are preserved (they render as paragraph breaks in the UI).

Lines starting with `<!--` are treated as comments and ignored by the parser.

---

## Example Card (complete)

```markdown
### Card 12 — Dominated Convergence Theorem [OWN]
**Front:** State the Dominated Convergence Theorem. What are the hypotheses,
and why is domination necessary?
**Back:** If $\{f_n\}$ is a sequence of measurable functions with $|f_n| \leq g$ a.e.
for some $g \in L^1(\mu)$, and $f_n \to f$ a.e., then $f \in L^1(\mu)$ and
$$\lim_{n \to \infty} \int f_n \, d\mu = \int f \, d\mu.$$
Domination prevents mass from "escaping to infinity". Counterexample without it:
$f_n = n \cdot \mathbf{1}_{(0, 1/n)}$ on $[0,1]$.
**Source ref:** §5
**Hint:** What does $g \in L^1$ buy you that pointwise bounds alone do not?
**Tags:** convergence, integral, key-theorem
```

---

## File Naming Convention

```
sparring-deck-<subject>.md
```

Examples: `sparring-deck-demo.md`, `sparring-deck-physics.md`

Place deck files in the `decks/` directory of the sparring repo, or symlink from wherever they live in your vault.

---

## Parser Output Schema

The parser (`scripts/parse-deck.py`) emits one JSON file per deck:

```json
{
  "meta": {
    "source_file": "sparring-deck-demo.md",
    "slug": "demo",
    "created": "2026-05-08",
    "tags": ["demo", "sparring"],
    "status": "active",
    "source": "Author, Book Title",
    "card_count": 72
  },
  "cards": [
    {
      "id": "demo-1",
      "num": "1",
      "title": "σ-algebra: axiomas",
      "topic": "Demo topic — Spaced Repetition Basics",
      "bloco": "A",
      "hard": false,
      "tags": ["OWN"],
      "front": "Enuncie os três axiomas de uma σ-algebra...",
      "back": "Prove que todos os finitos subconjuntos...",
      "refs": [{"label": "Source", "value": "§2"}],
      "hint": null
    }
  ]
}
```
