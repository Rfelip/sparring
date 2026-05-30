# SRS Algorithm — FSRS

## Why FSRS instead of SM-2

Sparring uses **FSRS** (Free Spaced Repetition Scheduler), not Anki's SM-2.

SM-2 was designed in 1987. It works, but it has known weaknesses:
- Fixed ease-factor decay that doesn't recover well from lapses.
- No forgetting-curve model — intervals are heuristic, not probabilistic.
- "Ease hell": cards can get stuck at minimum interval indefinitely.

FSRS was published in 2022–2023 and is now Anki's default algorithm (v3+). It models memory using a two-component system derived from the Ebbinghaus forgetting curve, optimized over millions of review logs. Key advantages:

- **Retrievability** target: schedules cards so you review just before predicted forgetting (default: 90% retention target).
- **Stability** + **Difficulty** per card: two independent parameters that evolve from your review history.
- **Lapse recovery**: stability partially survives a failed review instead of resetting to zero.
- **Optimizer**: parameters can be fit to your personal review history (optional, R3 feature).

## Algorithm Overview

FSRS tracks two quantities per card:

| Symbol | Name          | Meaning                                              |
|--------|---------------|------------------------------------------------------|
| `S`    | Stability     | Days until retention drops to 90% (R = 0.9).        |
| `D`    | Difficulty    | Intrinsic card difficulty in [1, 10].                |

The **retrievability** at time `t` after last review:

```
R(t) = (1 + FACTOR * t / S)^DECAY
```

where `FACTOR = -0.5 * DECAY^-1 - 1` and `DECAY = -0.5` (FSRS-5 constants).

On each review, the scheduler computes next interval as the `t` where `R(t) = desired_retention` (default 0.9).

### Rating Scale

| Rating | Label    | Meaning                                                    |
|--------|----------|------------------------------------------------------------|
| 1      | Again    | Complete blank / wrong. Reset.                             |
| 2      | Hard     | Recalled with serious effort. Shorter interval.            |
| 3      | Good     | Recalled correctly with normal effort. Scheduled normally. |
| 4      | Easy     | Trivial recall. Longer interval bonus.                     |

The current sparring TUI uses only Again / Good (1 / 3). The web app exposes all four to enable accurate FSRS scheduling.

### State Transitions

```
New → Learning → Review → Relearning
```

- **New**: never seen. First review initializes S and D from the rating.
- **Learning**: short intervals (minutes to days) until stable.
- **Review**: normal long-interval spaced repetition.
- **Relearning**: after Again on a Review card; S is reduced but not reset.

## Implementation

`scripts/fsrs.js` is a vanilla-JS port of the FSRS-5 reference implementation.  
Source: https://github.com/open-spaced-repetition/fsrs.js (MIT)

The implementation is self-contained (no dependencies) and runs in the browser. No server required.

## Default Parameters (FSRS-5)

```json
{
  "desired_retention": 0.90,
  "w": [
    0.4072, 1.1829, 3.1262, 15.4722,
    7.2102, 0.5316, 1.0651, 0.0589,
    1.5330, 0.1544, 0.9742, 2.0061,
    0.1075, 0.2848, 2.3527, 0.0000,
    2.9898, 0.5100, 0.4330
  ],
  "maximum_interval": 36500
}
```

These are the FSRS-5 global defaults trained on the AnkiDroid dataset. They work well without personal calibration. Per-user optimizer is a future feature (R3+).

## State Storage

Review state is stored in `localStorage` as JSON, keyed by deck slug. Format:

```json
{
  "version": 1,
  "cards": {
    "demo-1": {
      "state": "review",
      "due": "2026-05-15T00:00:00Z",
      "stability": 12.4,
      "difficulty": 5.2,
      "elapsed_days": 3,
      "scheduled_days": 12,
      "reps": 4,
      "lapses": 1,
      "last_review": "2026-05-03T14:22:00Z"
    }
  },
  "updated_at": "2026-05-10T09:00:00Z"
}
```

Export/import buttons allow backup and migration across devices.

## References

- Jarrett Ye et al., "A Stochastic Shortest Path Algorithm for Optimizing a Spaced Repetition Scheduler" (2022)
- FSRS-5 parameter training: https://github.com/open-spaced-repetition/fsrs-optimizer
- Open Spaced Repetition organization: https://github.com/open-spaced-repetition
