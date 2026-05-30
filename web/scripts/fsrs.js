/**
 * fsrs.js — FSRS-5 spaced repetition algorithm.
 *
 * A self-contained vanilla-JS implementation of FSRS-5.
 * No dependencies. Works in browser and Node.js.
 *
 * Reference: https://github.com/open-spaced-repetition/fsrs.js (MIT)
 * Paper: Ye et al., 2022. "A Stochastic Shortest Path Algorithm for
 *        Optimizing a Spaced Repetition Scheduler"
 *
 * Public API:
 *   const fsrs = new FSRS();
 *   const { card, log } = fsrs.repeat(card, now, rating);
 *   const due = fsrs.nextDue(card);
 *
 * Ratings: AGAIN=1, HARD=2, GOOD=3, EASY=4
 * States:  NEW=0, LEARNING=1, REVIEW=2, RELEARNING=3
 */

// ── Constants ──────────────────────────────────────────────────────────────

export const Rating = Object.freeze({ AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 });
export const State  = Object.freeze({ NEW: 0, LEARNING: 1, REVIEW: 2, RELEARNING: 3 });

const DECAY  = -0.5;
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1;   // ≈ 19/81 * 9^2 ≈ 0.234...

// FSRS-5 default weights (trained on AnkiDroid dataset)
const DEFAULT_W = [
  0.4072, 1.1829, 3.1262, 15.4722,
  7.2102, 0.5316, 1.0651,  0.0589,
  1.5330, 0.1544, 0.9742,  2.0061,
  0.1075, 0.2848, 2.3527,  0.0000,
  2.9898, 0.5100, 0.4330,
];

// ── Card factory ───────────────────────────────────────────────────────────

/**
 * Create a blank new card.
 * @param {string} id
 * @returns {FSRSCard}
 */
export function newCard(id) {
  return {
    id,
    state:          State.NEW,
    stability:      0,
    difficulty:     0,
    elapsed_days:   0,
    scheduled_days: 0,
    reps:           0,
    lapses:         0,
    last_review:    null,   // ISO string or null
    due:            null,   // ISO string or null
  };
}

// ── FSRS class ─────────────────────────────────────────────────────────────

export class FSRS {
  /**
   * @param {object} [params]
   * @param {number} [params.desired_retention=0.90]
   * @param {number} [params.maximum_interval=36500]
   * @param {number[]} [params.w]  — 19-element weight vector
   */
  constructor(params = {}) {
    this.desired_retention  = params.desired_retention  ?? 0.90;
    this.maximum_interval   = params.maximum_interval   ?? 36500;
    this.w                  = params.w                  ?? DEFAULT_W;
  }

  // ── Core math ─────────────────────────────────────────────────────────

  /** Retrievability at elapsed_days since last review. */
  forgettingCurve(elapsed_days, stability) {
    return Math.pow(1 + FACTOR * elapsed_days / stability, DECAY);
  }

  /** Interval (days) such that R(interval) = desired_retention. */
  nextInterval(stability) {
    const interval = stability / FACTOR * (Math.pow(this.desired_retention, 1 / DECAY) - 1);
    return Math.max(1, Math.min(Math.round(interval), this.maximum_interval));
  }

  // ── Initial stability (first review) ──────────────────────────────────

  initStability(rating) {
    return Math.max(this.w[rating - 1], 0.1);
  }

  initDifficulty(rating) {
    const d = this.w[4] - Math.exp(this.w[5] * (rating - 1)) + 1;
    return this._clampDiff(d);
  }

  // ── Difficulty update ──────────────────────────────────────────────────

  nextDifficulty(d, rating) {
    const delta_d = -this.w[6] * (rating - 3);
    const d_prime = d + delta_d * ((10 - d) / 9);
    return this._clampDiff(this._meanReversion(this.w[4], d_prime));
  }

  _meanReversion(init, current) {
    return this.w[7] * init + (1 - this.w[7]) * current;
  }

  _clampDiff(d) { return Math.min(Math.max(d, 1), 10); }

  // ── Stability updates ──────────────────────────────────────────────────

  shortTermStability(stability, rating) {
    return stability * Math.exp(this.w[17] * (rating - 3 + this.w[18]));
  }

  nextRecallStability(d, s, r, rating) {
    const hard_penalty  = rating === Rating.HARD ? this.w[15] : 1;
    const easy_bonus    = rating === Rating.EASY ? this.w[16] : 1;
    return s * (
      Math.exp(this.w[8]) *
      (11 - d) *
      Math.pow(s, -this.w[9]) *
      (Math.exp((1 - r) * this.w[10]) - 1) *
      hard_penalty *
      easy_bonus + 1
    );
  }

  nextForgetStability(d, s, r) {
    return (
      this.w[11] *
      Math.pow(d, -this.w[12]) *
      (Math.pow(s + 1, this.w[13]) - 1) *
      Math.exp((1 - r) * this.w[14])
    );
  }

  // ── Main scheduling function ───────────────────────────────────────────

  /**
   * Schedule a card after a review.
   *
   * @param {FSRSCard} card   — current card state (not mutated)
   * @param {Date|string} now — review timestamp
   * @param {number} rating   — Rating.AGAIN | HARD | GOOD | EASY
   * @returns {{ card: FSRSCard, log: ReviewLog }}
   */
  repeat(card, now, rating) {
    const reviewedAt = now instanceof Date ? now : new Date(now);
    const c = { ...card };

    // Compute elapsed days since last review
    let elapsed_days = 0;
    if (c.last_review) {
      const last = new Date(c.last_review);
      elapsed_days = Math.max(0,
        Math.floor((reviewedAt - last) / (1000 * 86400))
      );
    }

    const retrievability = c.state === State.REVIEW && c.stability > 0
      ? this.forgettingCurve(elapsed_days, c.stability)
      : 0;

    // ── NEW card ──────────────────────────────────────────────────────
    if (c.state === State.NEW) {
      c.difficulty = this.initDifficulty(rating);
      c.stability  = this.initStability(rating);

      if (rating === Rating.AGAIN) {
        c.state          = State.LEARNING;
        c.scheduled_days = 0;
        c.due            = this._addMinutes(reviewedAt, 1);
      } else if (rating === Rating.HARD) {
        c.state          = State.LEARNING;
        c.scheduled_days = 0;
        c.due            = this._addMinutes(reviewedAt, 5);
      } else if (rating === Rating.GOOD) {
        c.state          = State.LEARNING;
        c.scheduled_days = 0;
        c.due            = this._addMinutes(reviewedAt, 10);
      } else {  // EASY
        c.state          = State.REVIEW;
        c.scheduled_days = this.nextInterval(c.stability);
        c.due            = this._addDays(reviewedAt, c.scheduled_days);
      }

    // ── LEARNING card ─────────────────────────────────────────────────
    } else if (c.state === State.LEARNING || c.state === State.RELEARNING) {
      c.stability  = this.shortTermStability(c.stability, rating);
      c.difficulty = this.nextDifficulty(c.difficulty, rating);

      if (rating === Rating.AGAIN) {
        c.due = this._addMinutes(reviewedAt, 5);
      } else if (rating === Rating.HARD) {
        c.due = this._addMinutes(reviewedAt, 10);
      } else {  // GOOD or EASY
        c.state          = State.REVIEW;
        c.scheduled_days = this.nextInterval(c.stability);
        c.due            = this._addDays(reviewedAt, c.scheduled_days);
      }

    // ── REVIEW card ───────────────────────────────────────────────────
    } else {  // State.REVIEW
      c.difficulty = this.nextDifficulty(c.difficulty, rating);
      c.elapsed_days = elapsed_days;

      if (rating === Rating.AGAIN) {
        c.lapses     += 1;
        c.stability   = this.nextForgetStability(c.difficulty, c.stability, retrievability);
        c.state       = State.RELEARNING;
        c.scheduled_days = 0;
        c.due         = this._addMinutes(reviewedAt, 10);
      } else {
        c.stability   = this.nextRecallStability(c.difficulty, c.stability, retrievability, rating);
        c.state       = State.REVIEW;
        c.scheduled_days = this.nextInterval(c.stability);
        c.due         = this._addDays(reviewedAt, c.scheduled_days);
      }
    }

    c.reps        += 1;
    c.last_review  = reviewedAt.toISOString();

    const log = {
      card_id:       card.id,
      rating,
      state_before:  card.state,
      state_after:   c.state,
      elapsed_days,
      scheduled_days: c.scheduled_days,
      stability:     c.stability,
      difficulty:    c.difficulty,
      retrievability,
      reviewed_at:   reviewedAt.toISOString(),
    };

    return { card: c, log };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  _addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d.toISOString();
  }

  _addMinutes(date, minutes) {
    const d = new Date(date);
    d.setMinutes(d.getMinutes() + minutes);
    return d.toISOString();
  }

  /** True if the card is due at or before `now`. */
  isDue(card, now = new Date()) {
    if (!card.due) return true;
    return new Date(card.due) <= (now instanceof Date ? now : new Date(now));
  }
}

// ── Default singleton ───────────────────────────────────────────────────────

export const fsrs = new FSRS();
