/**
 * sparring/web/app.js — R3
 *
 * Full FSRS review loop with:
 *   - 3-D card flip animation
 *   - Rating buttons (Again/Hard/Good/Easy) with keyboard shortcuts (1234 / jkl;)
 *   - Space to flip, ← undo, → skip
 *   - FSRS state persist to localStorage on every rating
 *   - Progress bar + session timer
 *   - Session-end screen with stats
 *   - Empty-queue handling with study overrides (warm, encouraging copy)
 *   - Settings drawer (theme, caps, reset, export/import)
 *   - Deck filters (hard-only, review/new-only, bloco, random sample)
 *   - KaTeX math rendering (block + inline, two-pass tokeniser)
 *   - Stats view: per-deck breakdown, 90-day heatmap, 7-day forecast, streak
 *   - "Now studying" header stripe
 *   - Keyboard hint footer (dismissible)
 */

import { FSRS, Rating, State, newCard } from './scripts/fsrs.js';

// ── Constants ──────────────────────────────────────────────────────────────

const CONFIG_URL   = './sparring.config.json';
const STATE_PREFIX = 'sparring:state:';
const THEME_KEY    = 'sparring:theme';
const CAPS_KEY     = 'sparring:caps';
const KB_HINT_KEY  = 'sparring:kb-hint-dismissed';

// All localStorage keys we own — used to mirror state into the Python data dir.
const LS_KEYS = [THEME_KEY, CAPS_KEY, KB_HINT_KEY, 'sparring:activity', 'sparring:lang'];

// ── Python bridge ──────────────────────────────────────────────────────────
// When running inside the GTK shell (app/sparring_app.py), an in-process server
// exposes /__api/*. In a plain browser those routes 404 and the app degrades
// gracefully: edit mode is disabled and state stays in localStorage only.
const Bridge = {
  available: false,        // set by probe() at boot
  async probe() {
    try {
      const res = await fetch('./__api/ping', { method: 'GET' });
      if (!res.ok) return false;
      const j = await res.json();
      this.available = !!j.ok;
    } catch (_) { this.available = false; }
    return this.available;
  },
  async get(path) {
    const res = await fetch(`./__api/${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  async post(path, payload) {
    const res = await fetch(`./__api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { detail = (await res.json()).error ?? detail; } catch (_) {}
      throw new Error(detail);
    }
    return res.json();
  },
};

/** Fallback config when fetch fails (e.g. file:// without a server). */
const FALLBACK_CONFIG = {
  version: 1,
  decks: [],
  schedule: { new_cards_per_day: 10, review_cap_per_day: 50 },
  fsrs: { desired_retention: 0.90 },
  ui: { theme: 'lamp', language: 'pt', show_card_id: true, show_ref: true },
};

const RATING_LABELS = {
  pt: { again: 'De novo', hard: 'Difícil', good: 'Bom',  easy: 'Fácil' },
  en: { again: 'Again',   hard: 'Hard',    good: 'Good', easy: 'Easy'  },
};

const THEMES = ['lamp', 'felt', 'dark', 'sepia'];

// ── App state ─────────────────────────────────────────────────────────────

const App = {
  config:   null,   // loaded config
  decks:    [],     // { meta, cards }[] — loaded deck JSON
  fsrs:     null,   // FSRS instance
  lang:     'pt',

  // User-overridable caps (persisted separately so config doesn't mutate)
  caps: { new_per_day: 10, rev_per_day: 50 },

  // Active study session
  session:  null,

  // For undo: stack of { card, prevState } snapshots
  undoStack: [],

  // Edit mode (only usable when the Python bridge is available)
  editMode: false,
};

// ── DOM refs ──────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const DOM = {};

function bindDOM() {
  // Views
  DOM.viewHome  = $('view-home');
  DOM.viewStudy = $('view-study');
  DOM.viewDone  = $('view-done');
  DOM.viewStats = $('view-stats');

  // Home
  DOM.deckGrid   = $('deck-grid');
  DOM.homeStatus = $('home-status');

  // Study header
  DOM.btnBack         = $('btn-back');
  DOM.studyDeckName   = $('study-deck-name');
  DOM.progressFill    = $('progress-fill');
  DOM.progressCount   = $('progress-count');
  DOM.nowStudyingBar  = $('now-studying-bar');
  DOM.nowStudyingName = $('now-studying-name');

  // Flashcard
  DOM.flashcard     = $('flashcard');
  DOM.cardTopic     = $('card-topic');
  DOM.cardId        = $('card-id');
  DOM.cardTitle     = $('card-title');
  DOM.cardFrontText = $('card-front-text');
  DOM.cardFlipHint  = $('card-flip-hint');
  // back face
  DOM.cardTopicBack = $('card-topic-back');
  DOM.cardIdBack    = $('card-id-back');
  DOM.cardTitleBack = $('card-title-back');
  DOM.cardBackText  = $('card-back-text');
  DOM.cardRef       = $('card-ref');
  DOM.commentCard     = $('comment-card');
  DOM.cardCommentText = $('card-comment-text');

  DOM.btnFlip   = $('btn-flip');
  DOM.ratingRow = $('rating-row');

  // Session footer
  DOM.statAgain = $('stat-again');
  DOM.statHard  = $('stat-hard');
  DOM.statGood  = $('stat-good');
  DOM.statEasy  = $('stat-easy');
  DOM.statTime  = $('stat-time');

  // Keyboard hint footer
  DOM.kbHintFooter   = $('kb-hint-footer');
  DOM.kbHintDismiss  = $('kb-hint-dismiss');

  // Session-end
  DOM.doneTitle    = $('done-title');
  DOM.doneSubtitle = $('done-subtitle');
  DOM.doneStats    = $('done-stats');
  DOM.btnReviewAgain = $('btn-review-again');
  DOM.btnBackHome    = $('btn-back-home');

  // Filters
  DOM.filterBar    = $('filter-bar');
  DOM.filterBloco  = $('filter-bloco');
  DOM.filterSample = $('filter-sample');

  // Settings
  DOM.settingsToggle  = $('settings-toggle');
  DOM.settingsOverlay = $('settings-overlay');
  DOM.settingsDrawer  = $('settings-drawer');
  DOM.settingsClose   = $('settings-close');
  DOM.setTheme        = $('set-theme');
  DOM.setLanguage     = $('set-language');
  DOM.setNewCap       = $('set-new-cap');
  DOM.setRevCap       = $('set-rev-cap');
  DOM.btnResetDeck    = $('btn-reset-deck');
  DOM.resetDeckHint   = $('reset-deck-hint');
  DOM.btnExportState  = $('btn-export-state');
  DOM.btnImportState  = $('btn-import-state');
  DOM.importFileInput = $('import-file-input');

  DOM.toastContainer = $('toast-container');
  DOM.themeToggle    = $('theme-toggle');

  // Stats
  DOM.btnStatsNav      = $('btn-stats-nav');
  DOM.btnStatsBack     = $('btn-stats-back');
  DOM.statsSummaryRow  = $('stats-summary-row');
  DOM.statsDeckSection = $('stats-deck-section');
  DOM.heatmapGrid      = $('heatmap-grid');
  DOM.forecastBars     = $('forecast-bars');

  // Edit mode + card editor
  DOM.filterEditMode    = $('filter-edit-mode');
  DOM.editToolbar       = $('edit-toolbar');
  DOM.btnEditCurrent    = $('btn-edit-current');
  DOM.btnNewCard        = $('btn-new-card');
  DOM.btnDeleteCurrent  = $('btn-delete-current');
  DOM.editorOverlay     = $('editor-overlay');
  DOM.editorModal       = $('editor-modal');
  DOM.editorTitle       = $('editor-title');
  DOM.editorClose       = $('editor-close');
  DOM.editorCancel      = $('editor-cancel');
  DOM.editorSave        = $('editor-save');
  DOM.editorCopy        = $('editor-copy');
  DOM.editorHint        = $('editor-hint');
  DOM.edTitle           = $('ed-title');
  DOM.edBloco           = $('ed-bloco');
  DOM.edRef             = $('ed-ref');
  DOM.edTags            = $('ed-tags');
  DOM.edHard            = $('ed-hard');
  DOM.edFront           = $('ed-front');
  DOM.edBack            = $('ed-back');
  DOM.edComments        = $('ed-comments');
}

// ── View routing ──────────────────────────────────────────────────────────

function showView(name) {
  const views = { home: DOM.viewHome, study: DOM.viewStudy, done: DOM.viewDone, stats: DOM.viewStats };
  for (const [k, el] of Object.entries(views)) {
    if (el) el.classList.toggle('view--hidden', k !== name);
  }
}

// ── Config loading ────────────────────────────────────────────────────────

async function loadConfig() {
  try {
    const res = await fetch(CONFIG_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn('[sparring] Config fetch failed, using fallback:', e.message);
    return FALLBACK_CONFIG;
  }
}

// ── Deck loading ──────────────────────────────────────────────────────────

async function loadDeck(deckConfig) {
  const url = `./decks/${deckConfig.slug}.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn(`[sparring] Could not load deck "${deckConfig.slug}": ${e.message}`);
    return null;
  }
}

// ── Caps (user-overridable per-session limits) ────────────────────────────

function loadCaps() {
  try {
    const raw = localStorage.getItem(CAPS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return null;
}

function saveCaps(caps) {
  try { localStorage.setItem(CAPS_KEY, JSON.stringify(caps)); } catch (_) {}
  scheduleAppDataSync();
}

// ── State management ──────────────────────────────────────────────────────

function loadState(slug) {
  try {
    const raw = localStorage.getItem(STATE_PREFIX + slug);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return { version: 1, cards: {}, updated_at: null };
}

function saveState(slug, state) {
  state.updated_at = new Date().toISOString();
  try {
    localStorage.setItem(STATE_PREFIX + slug, JSON.stringify(state));
  } catch (e) {
    console.warn('[sparring] localStorage write failed:', e);
    toast('Atenção: estado não pôde ser salvo.', 4000);
  }
  scheduleAppDataSync();
}

// ── App-data persistence (per-user data dir via Python bridge) ─────────────
// localStorage is the live store the frontend reads; when the bridge is up we
// MIRROR the full localStorage snapshot to ~/.local/share/sparring/appdata.json
// (or the OS equivalent) so progress survives a localStorage wipe / repackaging.
// On boot we HYDRATE from that file if localStorage is empty (fresh install).

function snapshotLocalStorage() {
  const snap = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (key.startsWith(STATE_PREFIX) || LS_KEYS.includes(key)) {
      snap[key] = localStorage.getItem(key);
    }
  }
  return snap;
}

let _syncTimer = null;
function scheduleAppDataSync() {
  if (!Bridge.available) return;
  // Debounce: coalesce bursts of saves (rating a card writes state + activity).
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(syncAppDataNow, 400);
}

async function syncAppDataNow() {
  if (!Bridge.available) return;
  try {
    await Bridge.post('appdata', { version: 1, localStorage: snapshotLocalStorage() });
  } catch (e) {
    console.warn('[sparring] appdata sync failed:', e.message);
  }
}

async function hydrateFromAppData() {
  if (!Bridge.available) return;
  try {
    const { data } = await Bridge.get('appdata');
    const stored = data?.localStorage;
    if (!stored || typeof stored !== 'object') return;
    // Only hydrate keys missing locally — never clobber newer in-browser state.
    let restored = 0;
    for (const [k, v] of Object.entries(stored)) {
      if (localStorage.getItem(k) === null) {
        localStorage.setItem(k, v);
        restored++;
      }
    }
    if (restored) console.info(`[sparring] hydrated ${restored} key(s) from app data dir`);
  } catch (e) {
    console.warn('[sparring] appdata hydrate failed:', e.message);
  }
}

// ── Due card counts ───────────────────────────────────────────────────────

// A card that was just rated Again/Hard gets a *sub-day* learning step (its due
// jumps a few minutes ahead, state LEARNING/RELEARNING). The scheduler is right
// to resurface it inside the same session — but on the HOME grid it should NOT
// inflate the "X para revisar" badge: the deck is, for the day, finished. So the
// home count treats "due" as = brand-new cards + genuine REVIEW-state cards whose
// interval is ≥ ~1 day and whose due moment has passed. Same-day learning-step
// cards are tallied separately as `learning` ("aprendendo"). This changes ONLY
// what the badge/status line count — actual scheduling and in-session queueing
// (buildQueue) are untouched, so learning cards still resurface within a session.
function isHomeDue(cs, now) {
  if (!cs) return true;                                  // brand-new card
  if (!cs.due) return true;                              // never scheduled → treat as new
  if (new Date(cs.due) > now) return false;              // not yet due
  // Due moment has passed. Exclude same-day learning-step cards: those are in a
  // LEARNING/RELEARNING state with a sub-day (scheduled_days < 1) interval.
  const learningState = cs.state === State.LEARNING || cs.state === State.RELEARNING;
  const subDay = (cs.scheduled_days ?? 0) < 1;
  if (learningState && subDay) return false;             // counted under `learning`
  return true;                                            // genuine ≥1-day review, overdue
}

function getDueCounts(deckData) {
  if (!deckData) return { due: 0, total: 0, new: 0, learning: 0 };
  const slug  = deckData.meta.slug;
  const state = loadState(slug);
  const now   = new Date();
  const total = deckData.cards.length;
  let due = 0, newCount = 0, learning = 0;
  for (const card of deckData.cards) {
    const cs = state.cards[card.id];
    if (!cs) { newCount++; due++; continue; }
    if (isHomeDue(cs, now)) {
      due++;
    } else if ((cs.state === State.LEARNING || cs.state === State.RELEARNING)
               && cs.due && new Date(cs.due) <= now) {
      learning++;   // due moment passed but it's a same-day learning step
    }
  }
  return { due, total, new: newCount, learning };
}

// ── Deck grid rendering ───────────────────────────────────────────────────

function renderDeckGrid() {
  const grid = DOM.deckGrid;
  grid.innerHTML = '';

  const cfg  = App.config;
  const lang = App.lang;

  const enabledDecks = cfg.decks.filter(d => d.enabled !== false);

  if (enabledDecks.length === 0) {
    grid.innerHTML = `
      <li class="empty-state" style="grid-column:1/-1">
        <span class="empty-state-icon">📦</span>
        <h2>${lang === 'en' ? 'No decks configured' : 'Nenhum deck configurado'}</h2>
        <p>${lang === 'en'
          ? 'Edit <code>sparring.config.json</code> to add decks.'
          : 'Edite <code>sparring.config.json</code> para adicionar decks.'}</p>
      </li>`;
    return;
  }

  for (const deckCfg of enabledDecks) {
    const deckData   = App.decks.find(d => d?.meta?.slug === deckCfg.slug);
    const counts     = getDueCounts(deckData);
    const color      = deckCfg.color || 'var(--color-accent)';
    const icon       = deckCfg.icon || '📚';
    const totalCards = deckData?.meta?.card_count ?? deckData?.cards?.length ?? '?';

    const dueLabel   = lang === 'en' ? 'due'     : 'para revisar';
    const totalLabel = lang === 'en' ? 'cards'   : 'cartões';
    const learnLabel = lang === 'en' ? 'learning' : 'aprendendo';
    const startLabel = lang === 'en' ? 'Start session →' : 'Iniciar sessão →';
    const allDone    = lang === 'en' ? 'All caught up ✓' : 'Tudo em dia ✓';

    const li = document.createElement('li');
    li.className = 'deck-card';
    li.style.setProperty('--deck-color', color);
    li.dataset.slug = deckCfg.slug;
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');

    li.innerHTML = `
      <div class="deck-card-accent"></div>
      <div class="deck-card-body">
        <div class="deck-card-icon">${icon}</div>
        <div class="deck-card-name">${escapeHtml(deckCfg.name)}</div>
        <div class="deck-card-stats">
          ${counts.due > 0
            ? `<span class="stat-badge stat-badge--due">● ${counts.due} ${dueLabel}</span>`
            : ''}
          <span class="stat-badge">${totalCards} ${totalLabel}</span>
          ${counts.new > 0
            ? `<span class="stat-badge" style="color:var(--color-easy)">${counts.new} ${lang === 'en' ? 'new' : 'novos'}</span>`
            : ''}
          ${counts.learning > 0
            ? `<span class="stat-badge stat-badge--learning" style="color:var(--color-hard)">${counts.learning} ${learnLabel}</span>`
            : ''}
        </div>
        <div class="deck-card-cta">${(counts.due > 0 || counts.learning > 0) ? startLabel : allDone}</div>
      </div>
    `;

    li.addEventListener('click',   () => startStudy(deckCfg.slug));
    li.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') startStudy(deckCfg.slug); });
    grid.appendChild(li);
  }

  // Status line — same definition of "due" as the per-deck badge, plus a
  // separate "aprendendo" tally for same-day learning-step cards.
  const totals = App.decks.reduce((acc, d) => {
    const c = getDueCounts(d);
    acc.due += c.due;
    acc.learning += c.learning;
    return acc;
  }, { due: 0, learning: 0 });
  const totalDue = totals.due;
  const totalLearning = totals.learning;
  if (DOM.homeStatus) {
    let line;
    if (totalDue > 0) {
      line = lang === 'en'
        ? `${totalDue} card${totalDue !== 1 ? 's' : ''} due for review today.`
        : `${totalDue} cartão${totalDue !== 1 ? 's' : ''} para revisar hoje.`;
    } else {
      line = lang === 'en' ? 'All decks are up to date.' : 'Todos os decks estão em dia.';
    }
    if (totalLearning > 0) {
      line += lang === 'en'
        ? ` (+${totalLearning} learning)`
        : ` (+${totalLearning} aprendendo)`;
    }
    DOM.homeStatus.textContent = line;
  }
}

// ── Filter helpers ────────────────────────────────────────────────────────

function buildQueue(deckData, state, filterMode, filterBloco, sampleN) {
  const now     = new Date();
  const newCap  = App.caps.new_per_day;
  const revCap  = App.caps.rev_per_day;

  let cards = deckData.cards;

  // Bloco filter
  if (filterBloco) {
    cards = cards.filter(c => c.bloco === filterBloco);
  }

  // Hard-only filter
  if (filterMode === 'hard') {
    cards = cards.filter(c => c.hard || (c.id && c.id.startsWith('h-')));
  }

  const newCards = [];
  const dueCards = [];

  for (const card of cards) {
    const cs = state.cards[card.id];
    if (!cs) {
      if (filterMode !== 'review') newCards.push(card);
    } else if (cs.due && new Date(cs.due) <= now) {
      if (filterMode !== 'new') dueCards.push(card);
    }
  }

  // Sort due cards by due date (most overdue first)
  dueCards.sort((a, b) => {
    const da = state.cards[a.id]?.due ?? '0';
    const db = state.cards[b.id]?.due ?? '0';
    return da < db ? -1 : 1;
  });

  let queue = [
    ...dueCards.slice(0, revCap),
    ...newCards.slice(0, newCap),
  ];

  // Random study order: cards are presented shuffled, not due-date/file order.
  // (The caps + overdue priority above still decide *which* cards make the cut.)
  queue = shuffleArray(queue);

  // Random sample → queue is already shuffled, just trim to N.
  if (sampleN && sampleN > 0 && queue.length > sampleN) {
    queue = queue.slice(0, sampleN);
  }

  return queue;
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getActiveBlocos(deckData) {
  const set = new Set();
  for (const c of deckData.cards) {
    if (c.bloco) set.add(c.bloco);
  }
  return [...set].sort();
}

// ── Study session ─────────────────────────────────────────────────────────

function startStudy(slug, opts = {}) {
  const deckCfg  = App.config.decks.find(d => d.slug === slug);
  const deckData = App.decks.find(d => d?.meta?.slug === slug);

  if (!deckData || !deckCfg) {
    toast('Deck não carregado. Converta o .md primeiro com parse-deck.py.', 4000);
    return;
  }

  const color = deckCfg.color || 'var(--color-accent)';
  document.documentElement.style.setProperty('--deck-accent', color);

  const state      = loadState(slug);
  const filterMode = opts.filterMode ?? 'all';
  const filterBloco = opts.filterBloco ?? '';
  const sampleN    = opts.sampleN ?? 0;

  const queue = buildQueue(deckData, state, filterMode, filterBloco, sampleN);

  if (queue.length === 0) {
    showEmptyQueue(slug, deckCfg);
    return;
  }

  // Restore the flashcard markup in case a prior empty-queue hid it.
  restoreFlashcardScene();

  // Populate bloco filter dropdown
  const blocos = getActiveBlocos(deckData);
  DOM.filterBloco.innerHTML = `<option value="">${App.lang === 'en' ? 'All blocos' : 'Bloco: todos'}</option>`;
  for (const b of blocos) {
    const opt = document.createElement('option');
    opt.value = b;
    opt.textContent = `Bloco ${b}`;
    DOM.filterBloco.appendChild(opt);
  }
  DOM.filterBloco.value = filterBloco;

  // Set filter chip active state
  document.querySelectorAll('.filter-chip[data-filter]').forEach(c => {
    c.classList.toggle('filter-chip--active', c.dataset.filter === filterMode);
  });

  App.session = {
    slug,
    deckCfg,
    deckData,
    state,
    queue,
    fullQueue: [...queue],
    index:     0,
    counts:    { again: 0, hard: 0, good: 0, easy: 0 },
    flipped:   false,
    startTime: Date.now(),
    filterMode,
    filterBloco,
    sampleN,
  };
  App.undoStack = [];

  DOM.studyDeckName.textContent = deckCfg.name;
  DOM.filterBar.dataset.slug = slug;

  // "Now studying" stripe
  if (DOM.nowStudyingName) DOM.nowStudyingName.textContent = deckCfg.name;
  if (DOM.nowStudyingBar)  {
    DOM.nowStudyingBar.style.setProperty('--stripe-color', color);
    DOM.nowStudyingBar.classList.remove('now-studying-bar--hidden');
  }

  // Update settings hint
  if (DOM.resetDeckHint) DOM.resetDeckHint.textContent = deckCfg.name;

  // Show kb hint footer if not dismissed
  if (DOM.kbHintFooter) {
    const dismissed = localStorage.getItem(KB_HINT_KEY);
    DOM.kbHintFooter.classList.toggle('kb-hint-footer--hidden', !!dismissed);
  }

  showView('study');
  startTimer();
  renderCurrentCard();
}

let _timerInterval = null;

function startTimer() {
  clearInterval(_timerInterval);
  _timerInterval = setInterval(() => {
    if (!App.session) { clearInterval(_timerInterval); return; }
    const elapsed = Math.floor((Date.now() - App.session.startTime) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    DOM.statTime.textContent = `${m}:${String(s).padStart(2, '0')}`;
  }, 1000);
}

function restoreFlashcardScene() {
  const scene = $('flashcard-scene');
  if (!scene) return;
  const eq = scene.querySelector('.empty-queue') || DOM.viewStudy.querySelector('.empty-queue');
  if (eq) eq.remove();
  const fcc = scene.querySelector('.flashcard-container');
  if (fcc) fcc.style.display = '';
}

function showEmptyQueue(slug, deckCfg) {
  const lang = App.lang;
  const studyEl = DOM.viewStudy;

  // Show an empty-queue panel WITHOUT destroying the flashcard markup.
  // (bindDOM cached those nodes once at load — wiping the scene breaks every
  //  later render. We just hide the card and overlay the panel beside it.)
  const scene = $('flashcard-scene');
  const oldEmptyQueue = studyEl.querySelector('.empty-queue');
  if (oldEmptyQueue) oldEmptyQueue.remove();

  const fcc = scene.querySelector('.flashcard-container');
  if (fcc) fcc.style.display = 'none';
  const div = document.createElement('div');
  div.className = 'empty-queue';

  // Warm, encouraging copy — not clinical
  const messages = lang === 'en'
    ? [
        'Nothing due right now.',
        'Your future self is thanking you.',
        'Memory consolidated. Come back tomorrow!',
      ]
    : [
        'Nada vence hoje.',
        'Seu futuro eu agradece.',
        'Memória consolidada. Volte amanhã!',
      ];
  const msg = messages[Math.floor(Math.random() * messages.length)];

  div.innerHTML = `
    <div class="empty-queue-icon">☀️</div>
    <h2>${lang === 'en' ? 'All caught up!' : 'Tudo em dia!'}</h2>
    <p class="empty-queue-msg">${msg}</p>
    <p class="empty-queue-sub">${lang === 'en'
      ? 'You can still study new cards or do a free review.'
      : 'Você pode estudar cartões novos ou fazer uma revisão livre.'}</p>
    <div class="empty-queue-actions">
      <button class="btn-primary" id="eq-study-new">${lang === 'en' ? 'Study new cards' : 'Estudar novos'}</button>
      <button class="btn-secondary" id="eq-study-all">${lang === 'en' ? 'Free review (all cards)' : 'Revisão livre (todos)'}</button>
    </div>
  `;
  scene.appendChild(div);

  document.documentElement.style.setProperty('--deck-accent', deckCfg.color || 'var(--color-accent)');
  DOM.studyDeckName.textContent = deckCfg.name;
  DOM.progressFill.style.width  = '100%';
  DOM.progressCount.textContent = '';
  DOM.btnFlip.classList.add('btn-flip--hidden');
  DOM.ratingRow.classList.add('rating-row--hidden');
  if (DOM.nowStudyingBar) DOM.nowStudyingBar.classList.add('now-studying-bar--hidden');

  $('eq-study-new').addEventListener('click', () => {
    startStudy(slug, { filterMode: 'new' });
  });
  $('eq-study-all').addEventListener('click', () => {
    // Force all cards into queue ignoring due dates
    const deckData2 = App.decks.find(d => d?.meta?.slug === slug);
    if (!deckData2) return;
    const state = loadState(slug);
    const queue = deckData2.cards.slice(0, App.caps.rev_per_day + App.caps.new_per_day);

    App.session = {
      slug,
      deckCfg,
      deckData: deckData2,
      state,
      queue,
      fullQueue: [...queue],
      index:     0,
      counts:    { again: 0, hard: 0, good: 0, easy: 0 },
      flipped:   false,
      startTime: Date.now(),
      filterMode: 'all',
      filterBloco: '',
      sampleN: 0,
    };
    App.undoStack = [];
    scene.innerHTML = '';
    showView('study');
    startTimer();
    renderCurrentCard();
  });

  showView('study');
}

function renderCurrentCard() {
  const { session } = App;
  if (!session) return;

  const { queue, index, counts } = session;
  const card = queue[index];

  // Progress
  const total = queue.length;
  const pct   = total > 0 ? (index / total) * 100 : 0;
  DOM.progressFill.style.width = `${pct}%`;
  DOM.progressCount.textContent = `${index + 1} / ${total}`;

  // Session stats
  DOM.statAgain.textContent = counts.again;
  DOM.statHard.textContent  = counts.hard;
  DOM.statGood.textContent  = counts.good;
  DOM.statEasy.textContent  = counts.easy;

  // --- Front face ---
  DOM.cardTopic.textContent = card.topic ?? '';
  DOM.cardId.textContent    = App.config.ui?.show_card_id !== false ? `#${card.id}` : '';

  DOM.cardTitle.innerHTML = escapeHtml(card.title ?? '')
    + (card.hard ? '<span class="hard-badge">HARD</span>' : '');

  DOM.cardFrontText.innerHTML = renderMath(card.front ?? '');

  // --- Back face (pre-render so flip reveals instantly) ---
  DOM.cardTopicBack.textContent = card.topic ?? '';
  DOM.cardIdBack.textContent    = App.config.ui?.show_card_id !== false ? `#${card.id}` : '';

  DOM.cardTitleBack.innerHTML = escapeHtml(card.title ?? '')
    + (card.hard ? '<span class="hard-badge">HARD</span>' : '');

  DOM.cardBackText.innerHTML = renderMath(card.back ?? '');

  if (App.config.ui?.show_ref !== false && card.refs?.length) {
    DOM.cardRef.textContent = card.refs.map(r => r.label ? `${r.label} ref: ${r.value}` : `ref: ${r.value}`).join(' · ');
    DOM.cardRef.hidden = false;
  } else {
    DOM.cardRef.hidden = true;
  }

  // Comment — populated now, revealed as a separate card on flip.
  if (DOM.commentCard) {
    const cmt = (card.comments ?? '').trim();
    if (cmt) {
      DOM.cardCommentText.innerHTML = renderMath(cmt);
      DOM.commentCard.dataset.has = '1';
    } else {
      DOM.cardCommentText.innerHTML = '';
      DOM.commentCard.dataset.has = '';
    }
    DOM.commentCard.classList.add('comment-card--hidden');
  }

  // Reset flip state
  session.flipped = false;
  DOM.flashcard.classList.remove('flashcard--flipped');

  // Show flip button, hide ratings
  DOM.btnFlip.classList.remove('btn-flip--hidden');
  DOM.ratingRow.classList.remove('rating-row--hidden');
  DOM.ratingRow.classList.add('rating-row--hidden');

  // Update rating button labels
  updateRatingLabels();
}

function updateRatingLabels() {
  const labels  = App.config.ui?.rating_labels ?? RATING_LABELS[App.lang];
  const keys    = ['again', 'hard', 'good', 'easy'];
  const kbMap   = App.config.ui?.keyboard_shortcuts ?? {};
  const defKeys = { again: '1', hard: '2', good: '3', easy: '4' };
  const altKeys = { again: 'J', hard: 'K', good: 'L', easy: ';' };

  keys.forEach(key => {
    const btn    = document.querySelector(`.btn-rating--${key}`);
    if (!btn) return;
    const labelEl = btn.querySelector('.btn-rating-label');
    const keyEl   = btn.querySelector('.btn-rating-key');
    if (labelEl) labelEl.textContent = labels[key] ?? key;
    if (keyEl)   keyEl.textContent   = `${kbMap[key] ?? defKeys[key]} / ${altKeys[key]}`;
  });
}

function flipCard() {
  if (!App.session) return;
  if (App.session.flipped) return;
  App.session.flipped = true;
  DOM.flashcard.classList.add('flashcard--flipped');
  if (DOM.commentCard?.dataset.has === '1') {
    DOM.commentCard.classList.remove('comment-card--hidden');
  }
  DOM.btnFlip.classList.add('btn-flip--hidden');
  DOM.ratingRow.classList.remove('rating-row--hidden');
}

function rateCard(ratingKey) {
  const { session } = App;
  if (!session || !session.flipped) return;

  const ratingMap = { again: Rating.AGAIN, hard: Rating.HARD, good: Rating.GOOD, easy: Rating.EASY };
  const rating    = ratingMap[ratingKey];
  if (!rating) return;

  const card      = session.queue[session.index];
  const prevState = session.state.cards[card.id] ?? null;
  const cardState = prevState ? { ...prevState } : newCard(card.id);
  const { card: updated } = App.fsrs.repeat(cardState, new Date(), rating);

  // Save snapshot for undo
  App.undoStack.push({ index: session.index, cardId: card.id, prevState, ratingKey });

  // Apply
  session.state.cards[card.id] = updated;
  session.counts[ratingKey]++;

  // Record activity for stats
  recordActivity();

  // Persist immediately
  saveState(session.slug, session.state);

  // Advance or finish
  session.index++;
  if (session.index >= session.queue.length) {
    finishSession();
  } else {
    renderCurrentCard();
  }
}

function undoLast() {
  const { session } = App;
  if (!session || App.undoStack.length === 0) {
    toast(App.lang === 'en' ? 'Nothing to undo.' : 'Nada para desfazer.');
    return;
  }

  const snap = App.undoStack.pop();
  session.counts[snap.ratingKey] = Math.max(0, session.counts[snap.ratingKey] - 1);

  // Restore card state
  if (snap.prevState) {
    session.state.cards[snap.cardId] = snap.prevState;
  } else {
    delete session.state.cards[snap.cardId];
  }
  saveState(session.slug, session.state);

  session.index = snap.index;
  session.flipped = false;
  renderCurrentCard();

  toast(App.lang === 'en' ? 'Undone.' : 'Desfeito.', 1500);
}

function skipCard() {
  const { session } = App;
  if (!session) return;
  if (session.index + 1 >= session.queue.length) {
    toast(App.lang === 'en' ? 'Last card.' : 'Último cartão.', 1500);
    return;
  }
  session.index++;
  session.flipped = false;
  renderCurrentCard();
  toast(App.lang === 'en' ? 'Skipped.' : 'Pulado.', 1200);
}

function finishSession() {
  const { session } = App;
  clearInterval(_timerInterval);
  saveState(session.slug, session.state);

  // Hide "now studying" stripe
  if (DOM.nowStudyingBar) DOM.nowStudyingBar.classList.add('now-studying-bar--hidden');

  const { again, hard, good, easy } = session.counts;
  const total    = again + hard + good + easy;
  const correct  = good + easy;
  const elapsed  = Math.floor((Date.now() - session.startTime) / 1000);
  const m        = Math.floor(elapsed / 60);
  const s        = elapsed % 60;
  const timeStr  = `${m}:${String(s).padStart(2, '0')}`;
  const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;
  const lang     = App.lang;

  // Encouraging subtitle variants
  const subtitles = lang === 'en'
    ? [`${accuracy}% accuracy — great work.`, `${accuracy}% — memory strengthened.`, `${accuracy}% — proof retained.`]
    : [`${accuracy}% de acerto — bom trabalho!`, `${accuracy}% — memória fortalecida.`, `${accuracy}% — prova retida.`];
  const subtitle = subtitles[Math.floor(Math.random() * subtitles.length)];

  // Build done screen
  DOM.doneTitle.textContent    = lang === 'en' ? 'Session complete!' : 'Sessão concluída!';
  DOM.doneSubtitle.textContent = subtitle;

  DOM.doneStats.innerHTML = `
    <div class="done-stat">
      <div class="done-stat-label">${lang === 'en' ? 'Reviewed' : 'Revisados'}</div>
      <div class="done-stat-value">${total}</div>
    </div>
    <div class="done-stat">
      <div class="done-stat-label">${lang === 'en' ? 'Accuracy' : 'Acerto'}</div>
      <div class="done-stat-value">${accuracy}%</div>
    </div>
    <div class="done-stat">
      <div class="done-stat-label">${lang === 'en' ? 'Time' : 'Tempo'}</div>
      <div class="done-stat-value">${timeStr}</div>
    </div>
    <div class="done-stat">
      <div class="done-stat-label">${lang === 'en' ? 'Again' : 'De novo'}</div>
      <div class="done-stat-value" style="color:var(--color-again)">${again}</div>
    </div>
  `;

  // Wire "review again" to re-use same filter params
  const { slug, filterMode, filterBloco, sampleN } = session;
  DOM.btnReviewAgain.onclick = () => {
    document.documentElement.style.removeProperty('--deck-accent');
    App.session = null;
    startStudy(slug, { filterMode, filterBloco, sampleN });
  };

  document.documentElement.style.removeProperty('--deck-accent');
  App.session = null;
  showView('done');
}

// ── Activity tracking (for stats heatmap) ────────────────────────────────

const ACTIVITY_KEY = 'sparring:activity';

function loadActivity() {
  try {
    const raw = localStorage.getItem(ACTIVITY_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return {};  // { 'YYYY-MM-DD': count }
}

function saveActivity(activity) {
  try { localStorage.setItem(ACTIVITY_KEY, JSON.stringify(activity)); } catch (_) {}
  scheduleAppDataSync();
}

function recordActivity() {
  const today = todayStr();
  const activity = loadActivity();
  activity[today] = (activity[today] ?? 0) + 1;
  saveActivity(activity);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ── Stats view ────────────────────────────────────────────────────────────

function renderStats() {
  const lang = App.lang;

  // ── Per-deck breakdown
  const deckSection = DOM.statsDeckSection;
  deckSection.innerHTML = '';

  const MASTERED_DAYS = 30; // stability > 30 days = "mastered"

  App.config.decks.filter(d => d.enabled !== false).forEach(deckCfg => {
    const deckData = App.decks.find(d => d?.meta?.slug === deckCfg.slug);
    if (!deckData) return;

    const state   = loadState(deckCfg.slug);
    const now     = new Date();
    const cards   = deckData.cards;
    const total   = cards.length;
    let seen      = 0, mastered = 0, learning = 0, lapses = 0, due = 0;

    for (const card of cards) {
      const cs = state.cards[card.id];
      if (!cs) continue;
      seen++;
      if (cs.stability >= MASTERED_DAYS) mastered++;
      else learning++;
      lapses += cs.lapses ?? 0;
      if (cs.due && new Date(cs.due) <= now) due++;
    }

    const newCards = total - seen;
    const color = deckCfg.color || 'var(--color-accent)';

    const card = document.createElement('div');
    card.className = 'stats-deck-card';
    card.style.setProperty('--deck-color', color);
    card.innerHTML = `
      <div class="stats-deck-header">
        <span class="stats-deck-icon">${deckCfg.icon || '📚'}</span>
        <span class="stats-deck-name">${escapeHtml(deckCfg.name)}</span>
      </div>
      <div class="stats-deck-grid">
        <div class="stats-cell">
          <div class="stats-cell-val">${total}</div>
          <div class="stats-cell-label">${lang === 'en' ? 'Total' : 'Total'}</div>
        </div>
        <div class="stats-cell stats-cell--due">
          <div class="stats-cell-val">${due}</div>
          <div class="stats-cell-label">${lang === 'en' ? 'Due now' : 'Para hoje'}</div>
        </div>
        <div class="stats-cell stats-cell--mastered">
          <div class="stats-cell-val">${mastered}</div>
          <div class="stats-cell-label">${lang === 'en' ? 'Mastered' : 'Dominados'}</div>
        </div>
        <div class="stats-cell stats-cell--learning">
          <div class="stats-cell-val">${learning}</div>
          <div class="stats-cell-label">${lang === 'en' ? 'Learning' : 'Aprendendo'}</div>
        </div>
        <div class="stats-cell stats-cell--new">
          <div class="stats-cell-val">${newCards}</div>
          <div class="stats-cell-label">${lang === 'en' ? 'New' : 'Novos'}</div>
        </div>
        <div class="stats-cell stats-cell--lapses">
          <div class="stats-cell-val">${lapses}</div>
          <div class="stats-cell-label">${lang === 'en' ? 'Lapses' : 'Lapsos'}</div>
        </div>
      </div>
    `;
    deckSection.appendChild(card);
  });

  // ── Summary row: streak + total reviewed
  const activity = loadActivity();
  const streak   = computeStreak(activity);
  const totalReviewed = Object.values(activity).reduce((s, v) => s + v, 0);

  DOM.statsSummaryRow.innerHTML = `
    <div class="summary-stat">
      <div class="summary-stat-icon">🔥</div>
      <div class="summary-stat-val">${streak}</div>
      <div class="summary-stat-label">${lang === 'en' ? `day${streak !== 1 ? 's' : ''} streak` : `dia${streak !== 1 ? 's' : ''} seguidos`}</div>
    </div>
    <div class="summary-stat">
      <div class="summary-stat-icon">📇</div>
      <div class="summary-stat-val">${totalReviewed}</div>
      <div class="summary-stat-label">${lang === 'en' ? 'total reviewed' : 'revisões totais'}</div>
    </div>
    <div class="summary-stat">
      <div class="summary-stat-icon">📅</div>
      <div class="summary-stat-val">${Object.keys(activity).length}</div>
      <div class="summary-stat-label">${lang === 'en' ? 'study days' : 'dias estudados'}</div>
    </div>
  `;

  // ── Heatmap: last 90 days
  renderHeatmap(activity);

  // ── 7-day forecast
  renderForecast(lang);
}

function computeStreak(activity) {
  let streak = 0;
  const d = new Date();
  // allow today to count even if not yet studied
  // but don't penalize if today hasn't been studied yet — start from yesterday
  // Actually: if today has reviews, count forward. Else start from yesterday.
  const todayKey = todayStr();
  const hasToday = (activity[todayKey] ?? 0) > 0;
  if (!hasToday) d.setDate(d.getDate() - 1);

  while (true) {
    const key = d.toISOString().slice(0, 10);
    if ((activity[key] ?? 0) > 0) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

function renderHeatmap(activity) {
  const grid = DOM.heatmapGrid;
  grid.innerHTML = '';

  // Build 90-day range, padded to start on Monday
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const endDate = new Date(today);
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - 89);

  // Pad to previous Monday
  const startDow = (startDate.getDay() + 6) % 7; // 0=Mon
  startDate.setDate(startDate.getDate() - startDow);

  // Find max activity for color scaling
  let maxVal = 1;
  for (const v of Object.values(activity)) {
    if (v > maxVal) maxVal = v;
  }

  // Build grid column by column (week-by-week)
  const cur = new Date(startDate);
  while (cur <= endDate) {
    const col = document.createElement('div');
    col.className = 'heatmap-col';

    for (let dow = 0; dow < 7; dow++) {
      const key  = cur.toISOString().slice(0, 10);
      const count = activity[key] ?? 0;
      const future = cur > today;
      const outOfRange = cur < new Date(today.getTime() - 89 * 86400000);

      const cell = document.createElement('div');
      cell.className = 'heatmap-cell';

      if (future || outOfRange) {
        cell.dataset.level = '0';
        cell.dataset.empty = '1';
      } else {
        const level = count === 0 ? 0
          : count < maxVal * 0.25 ? 1
          : count < maxVal * 0.5  ? 2
          : count < maxVal * 0.75 ? 3 : 4;
        cell.dataset.level = String(level);
        cell.title = `${key}: ${count} revisõe${count !== 1 ? 's' : ''}`;
      }

      col.appendChild(cell);
      cur.setDate(cur.getDate() + 1);
    }

    grid.appendChild(col);
  }
}

function renderForecast(lang) {
  const bars = DOM.forecastBars;
  bars.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Collect all due dates across all decks for next 7 days
  const dayCounts = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dayCounts[d.toISOString().slice(0, 10)] = 0;
  }

  for (const deckData of App.decks) {
    if (!deckData) continue;
    const state = loadState(deckData.meta.slug);
    for (const card of deckData.cards) {
      const cs = state.cards[card.id];
      if (!cs?.due) continue;
      const due = cs.due.slice(0, 10);
      if (due in dayCounts) dayCounts[due]++;
    }
  }

  const maxCount = Math.max(1, ...Object.values(dayCounts));

  const days = lang === 'en'
    ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
    : ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

  Object.entries(dayCounts).forEach(([dateStr, count], i) => {
    const d = new Date(dateStr + 'T12:00:00');
    const dayName = i === 0 ? (lang === 'en' ? 'today' : 'hoje') : days[d.getDay()];
    const pct = Math.round((count / maxCount) * 100);

    const bar = document.createElement('div');
    bar.className = 'forecast-bar';
    bar.innerHTML = `
      <div class="forecast-bar-count">${count > 0 ? count : ''}</div>
      <div class="forecast-bar-fill-wrap">
        <div class="forecast-bar-fill" style="height:${pct}%"></div>
      </div>
      <div class="forecast-bar-label${i === 0 ? ' forecast-bar-label--today' : ''}">${dayName}</div>
    `;
    bars.appendChild(bar);
  });
}

// ── Light inline markdown for the non-math text runs ──────────────────────
// Applied AFTER escapeHtml (HTML already safe); LaTeX is tokenised separately
// by renderMath and never passes through here.
function mdInline(s) {
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/(^|\n)\s*-\s+/g, '$1• ');
  return s;   // newline → <br>/<p> handled by the caller's paragraph logic
}

// ── Math rendering (KaTeX) ────────────────────────────────────────────────

function renderMath(text) {
  if (typeof katex === 'undefined') {
    return `<p>${escapeHtml(text).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
  }

  // Two-pass tokeniser: block math ($$...$$) first, then inline ($...$),
  // then plain text. Preserves order without regex ambiguity.

  // Block math pass
  let m;
  const blockParts = [];
  const blockRegex = /\$\$([\s\S]*?)\$\$/g;
  while ((m = blockRegex.exec(text)) !== null) {
    blockParts.push({ start: m.index, end: m.index + m[0].length, type: 'block', expr: m[1] });
  }

  // Inline math pass (only in gaps between block math)
  const allTokens = [];
  let cursor = 0;
  for (const bp of blockParts) {
    // text gap before block
    if (cursor < bp.start) {
      allTokens.push({ type: 'text', raw: text.slice(cursor, bp.start) });
    }
    allTokens.push(bp);
    cursor = bp.end;
  }
  if (cursor < text.length) {
    allTokens.push({ type: 'text', raw: text.slice(cursor) });
  }

  // Expand text tokens: find inline math
  const finalTokens = [];
  for (const tok of allTokens) {
    if (tok.type !== 'text') { finalTokens.push(tok); continue; }
    const inlineRegex = /\$([^$\n]+?)\$/g;
    let iLast = 0;
    let im;
    while ((im = inlineRegex.exec(tok.raw)) !== null) {
      if (im.index > iLast) {
        finalTokens.push({ type: 'plain', raw: tok.raw.slice(iLast, im.index) });
      }
      finalTokens.push({ type: 'inline', expr: im[1] });
      iLast = im.index + im[0].length;
    }
    if (iLast < tok.raw.length) {
      finalTokens.push({ type: 'plain', raw: tok.raw.slice(iLast) });
    }
  }

  // Render
  let html = '';
  for (const tok of finalTokens) {
    if (tok.type === 'block') {
      try {
        html += `<div class="katex-display">${katex.renderToString(tok.expr, {
          displayMode: true,
          throwOnError: false,
          trust: false,
          macros: { '\\R': '\\mathbb{R}', '\\N': '\\mathbb{N}', '\\Z': '\\mathbb{Z}' },
        })}</div>`;
      } catch (_) {
        html += `<code>$$${escapeHtml(tok.expr)}$$</code>`;
      }
    } else if (tok.type === 'inline') {
      try {
        html += katex.renderToString(tok.expr, {
          displayMode: false,
          throwOnError: false,
          trust: false,
          macros: { '\\R': '\\mathbb{R}', '\\N': '\\mathbb{N}', '\\Z': '\\mathbb{Z}' },
        });
      } catch (_) {
        html += `<code>$${escapeHtml(tok.expr)}$</code>`;
      }
    } else {
      // plain text — light markdown, then paragraph/line breaks
      const md = mdInline(escapeHtml(tok.raw));
      html += md.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>');
    }
  }

  return `<p>${html}</p>`;
}

// ── Theme management ──────────────────────────────────────────────────────

let currentThemeIdx = 0;

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'lamp' ? '' : theme;
  localStorage.setItem(THEME_KEY, theme);
  if (DOM.setTheme) DOM.setTheme.value = theme;
  scheduleAppDataSync();
}

function cycleTheme() {
  currentThemeIdx = (currentThemeIdx + 1) % THEMES.length;
  applyTheme(THEMES[currentThemeIdx]);
  toast(`Theme: ${THEMES[currentThemeIdx]}`);
}

// ── Settings panel ────────────────────────────────────────────────────────

function openSettings() {
  DOM.settingsDrawer.classList.add('is-open');
  DOM.settingsOverlay.classList.add('is-open');
  DOM.settingsDrawer.setAttribute('aria-hidden', 'false');
}

function closeSettings() {
  DOM.settingsDrawer.classList.remove('is-open');
  DOM.settingsOverlay.classList.remove('is-open');
  DOM.settingsDrawer.setAttribute('aria-hidden', 'true');
}

function initSettingsPanel() {
  // Set initial values
  DOM.setTheme.value    = THEMES[currentThemeIdx] ?? 'lamp';
  DOM.setLanguage.value = App.lang;
  DOM.setNewCap.value   = App.caps.new_per_day;
  DOM.setRevCap.value   = App.caps.rev_per_day;

  DOM.setTheme.addEventListener('change', () => {
    const t = DOM.setTheme.value;
    currentThemeIdx = Math.max(0, THEMES.indexOf(t));
    applyTheme(t);
  });

  DOM.setLanguage.addEventListener('change', () => {
    App.lang = DOM.setLanguage.value;
    renderDeckGrid();
    updateRatingLabels();
    toast(App.lang === 'en' ? 'Language: English' : 'Idioma: Português', 1500);
  });

  DOM.setNewCap.addEventListener('change', () => {
    const v = parseInt(DOM.setNewCap.value, 10);
    if (isNaN(v) || v < 0) return;
    App.caps.new_per_day = v;
    saveCaps(App.caps);
  });

  DOM.setRevCap.addEventListener('change', () => {
    const v = parseInt(DOM.setRevCap.value, 10);
    if (isNaN(v) || v < 0) return;
    App.caps.rev_per_day = v;
    saveCaps(App.caps);
  });

  DOM.btnResetDeck.addEventListener('click', () => {
    // Find current deck slug from filter bar dataset or session
    const slug = App.session?.slug
      ?? DOM.filterBar?.dataset?.slug
      ?? App.config?.decks?.[0]?.slug;
    if (!slug) {
      toast('Nenhum deck selecionado.', 2000);
      return;
    }
    const name = App.config.decks.find(d => d.slug === slug)?.name ?? slug;
    if (!confirm(`Resetar progresso do deck "${name}"? Isso apagará todo o histórico.`)) return;
    localStorage.removeItem(STATE_PREFIX + slug);
    toast(`Progresso de "${name}" resetado.`, 2500);
    renderDeckGrid();
  });

  DOM.btnExportState.addEventListener('click', exportAllState);
  DOM.btnImportState.addEventListener('click', () => DOM.importFileInput.click());
  DOM.importFileInput.addEventListener('change', handleImportFile);
}

function exportAllState() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(STATE_PREFIX)) {
      try { data[key] = JSON.parse(localStorage.getItem(key)); } catch (_) {}
    }
  }
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `sparring-state-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Estado exportado.', 2000);
}

function handleImportFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      let count = 0;
      for (const [key, val] of Object.entries(data)) {
        if (key.startsWith(STATE_PREFIX)) {
          localStorage.setItem(key, JSON.stringify(val));
          count++;
        }
      }
      renderDeckGrid();
      toast(`Importado: ${count} deck(s).`, 2500);
    } catch (_) {
      toast('Erro ao importar — JSON inválido.', 3000);
    }
    // Reset so same file can be re-selected
    DOM.importFileInput.value = '';
  };
  reader.readAsText(file);
}

// ── Edit mode + card CRUD (via Python bridge) ─────────────────────────────
// Edit mode is only offered when the bridge is up (the page is running inside
// the GTK shell). In a plain browser the toggle stays hidden; the editor can
// still be opened read-to-clipboard via "Copiar YAML" as a documented fallback.

function reflectEditMode() {
  const on = App.editMode;
  DOM.filterEditMode?.classList.toggle('filter-chip--active', on);
  DOM.editToolbar?.classList.toggle('edit-toolbar--hidden', !on);
}

function toggleEditMode() {
  if (!Bridge.available) {
    toast(App.lang === 'en'
      ? 'Edit mode needs the desktop app (Python bridge).'
      : 'Modo edição requer o app desktop (bridge Python).', 3500);
    return;
  }
  App.editMode = !App.editMode;
  reflectEditMode();
  toast(App.editMode
    ? (App.lang === 'en' ? 'Edit mode ON' : 'Modo edição LIGADO')
    : (App.lang === 'en' ? 'Edit mode OFF' : 'Modo edição DESLIGADO'), 1500);
}

// Editor target: { mode: 'create'|'edit', slug, card? }
let _editorTarget = null;

function openEditor(mode, slug, card) {
  _editorTarget = { mode, slug, card: card ?? null };
  DOM.editorTitle.textContent = mode === 'create'
    ? (App.lang === 'en' ? 'New card' : 'Novo cartão')
    : (App.lang === 'en' ? 'Edit card' : 'Editar cartão');

  const c = card ?? {};
  DOM.edTitle.value    = c.title ?? '';
  DOM.edBloco.value    = c.bloco ?? '';
  DOM.edRef.value      = (c.refs?.[0]?.value) ?? '';
  DOM.edTags.value     = (c.tags ?? []).join(', ');
  DOM.edHard.checked   = !!c.hard;
  DOM.edFront.value    = c.front ?? '';
  DOM.edBack.value     = c.back ?? '';
  DOM.edComments.value = c.comments ?? '';

  DOM.editorHint.textContent = Bridge.available
    ? (App.lang === 'en'
        ? `Saves to cards/${slug}/ then rebuilds the deck.`
        : `Salva em cards/${slug}/ e recompila o deck.`)
    : (App.lang === 'en'
        ? 'No bridge — use "Copy YAML" and paste into a file manually.'
        : 'Sem bridge — use "Copiar YAML" e cole num arquivo manualmente.');
  DOM.editorHint.classList.toggle('editor-hint--warn', !Bridge.available);

  // Hide Save when there's no bridge; the copy-YAML fallback still works.
  DOM.editorSave.style.display = Bridge.available ? '' : 'none';

  DOM.editorModal.classList.add('is-open');
  DOM.editorOverlay.classList.add('is-open');
  DOM.editorModal.setAttribute('aria-hidden', 'false');
  setTimeout(() => DOM.edTitle.focus(), 50);
}

function closeEditor() {
  DOM.editorModal.classList.remove('is-open');
  DOM.editorOverlay.classList.remove('is-open');
  DOM.editorModal.setAttribute('aria-hidden', 'true');
  _editorTarget = null;
}

function collectEditorPayload() {
  if (!_editorTarget) return null;
  const tags = DOM.edTags.value.split(',').map(s => s.trim()).filter(Boolean);
  const payload = {
    deck:     _editorTarget.slug,
    title:    DOM.edTitle.value.trim(),
    bloco:    DOM.edBloco.value.trim(),
    ref:      DOM.edRef.value.trim(),
    tags,
    hard:     DOM.edHard.checked,
    front:    DOM.edFront.value,
    back:     DOM.edBack.value,
    comments: DOM.edComments.value,
  };
  if (_editorTarget.mode === 'edit' && _editorTarget.card?.id) {
    payload.id = _editorTarget.card.id;   // keep id stable on edit
  }
  return payload;
}

async function saveEditor() {
  const payload = collectEditorPayload();
  if (!payload) return;
  if (!payload.front.trim() || !payload.back.trim()) {
    toast(App.lang === 'en' ? 'Front and back are required.' : 'Frente e verso são obrigatórios.', 3000);
    return;
  }
  try {
    const res = await Bridge.post('card/save', payload);
    if (!res.ok) throw new Error(res.error || 'build failed');
    toast(App.lang === 'en' ? `Saved (${res.id}).` : `Salvo (${res.id}).`, 2000);
    closeEditor();
    await reloadDeckAndRefresh(payload.deck);
  } catch (e) {
    toast((App.lang === 'en' ? 'Save failed: ' : 'Falha ao salvar: ') + e.message, 4000);
  }
}

async function deleteCurrentCard() {
  if (!App.session) return;
  const card = App.session.queue[App.session.index];
  if (!card) return;
  const name = card.title || card.id;
  if (!confirm(App.lang === 'en'
      ? `Delete card "${name}"? This removes its YAML file.`
      : `Apagar o cartão "${name}"? Isso remove o arquivo YAML.`)) return;
  try {
    const res = await Bridge.post('card/delete', { deck: App.session.slug, id: card.id });
    if (!res.ok) throw new Error(res.error || 'build failed');
    toast(App.lang === 'en' ? 'Deleted.' : 'Apagado.', 2000);
    const slug = App.session.slug;
    await reloadDeckAndRefresh(slug);
    // Re-enter the deck so the queue rebuilds without the deleted card.
    startStudy(slug, { filterMode: App.session?.filterMode ?? 'all' });
  } catch (e) {
    toast((App.lang === 'en' ? 'Delete failed: ' : 'Falha ao apagar: ') + e.message, 4000);
  }
}

// Re-fetch the deck JSON (build.py just rewrote it) and update App.decks.
async function reloadDeckAndRefresh(slug) {
  const fresh = await loadDeck({ slug });
  if (fresh) {
    const idx = App.decks.findIndex(d => d?.meta?.slug === slug);
    if (idx >= 0) App.decks[idx] = fresh;
    else App.decks.push(fresh);
    if (App.session?.slug === slug) App.session.deckData = fresh;
  }
  renderDeckGrid();
}

// "Copy YAML" fallback — renders the same YAML shape build.py expects so a user
// without the bridge can paste it into cards/<slug>/<file>.yaml by hand.
function editorYamlString() {
  const p = collectEditorPayload();
  if (!p) return '';
  const q = s => {
    s = String(s ?? '');
    return /^[\w §.()/+-]*$/.test(s) && s === s.trim() && s !== ''
      ? s : JSON.stringify(s);
  };
  const block = (field, val) => {
    const text = String(val ?? '').replace(/\n+$/, '');
    if (!text) return `${field}: |\n  \n`;
    return `${field}: |\n` + text.split('\n').map(l => l ? '  ' + l : '').join('\n') + '\n';
  };
  const id = p.id ?? `${p.deck}-NEW`;
  const tags = p.tags.length ? '[' + p.tags.map(q).join(', ') + ']' : '[]';
  return [
    `id: ${q(id)}`,
    `deck: ${q(p.deck)}`,
    `order: 9999`,
    `bloco: ${q(p.bloco)}`,
    `title: ${q(p.title)}`,
    `hard: ${p.hard ? 'true' : 'false'}`,
    `tags: ${tags}`,
    `ref: ${q(p.ref)}`,
  ].join('\n') + '\n'
    + block('front', p.front) + block('back', p.back) + block('comments', p.comments);
}

async function copyEditorYaml() {
  const yaml = editorYamlString();
  try {
    await navigator.clipboard.writeText(yaml);
    toast(App.lang === 'en' ? 'YAML copied.' : 'YAML copiado.', 2000);
  } catch (_) {
    // Clipboard blocked — show it so the user can copy manually.
    prompt(App.lang === 'en' ? 'Copy this YAML:' : 'Copie este YAML:', yaml);
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────

function toast(message, duration = 2500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  DOM.toastContainer.appendChild(el);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('toast--visible'));
  });
  setTimeout(() => {
    el.classList.remove('toast--visible');
    setTimeout(() => el.remove(), 250);
  }, duration);
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────

function handleKeydown(e) {
  // Don't capture when typing in inputs or settings/editor are open
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (DOM.settingsDrawer?.classList.contains('is-open')) return;
  if (DOM.editorModal?.classList.contains('is-open')) {
    if (e.key === 'Escape') closeEditor();
    return;
  }

  const cfg  = App.config?.ui?.keyboard_shortcuts ?? {};
  const flip = cfg.flip ?? 'Space';

  // Space → flip
  if (e.key === ' ' && flip === 'Space') {
    e.preventDefault();
    if (App.session && !App.session.flipped) flipCard();
    return;
  }

  // Arrow left → undo
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    undoLast();
    return;
  }

  // Arrow right → skip (only when unflipped)
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (App.session && !App.session.flipped) skipCard();
    return;
  }

  // Rating keys — 1234 or jkl;
  if (App.session?.flipped) {
    const ratingMap = {
      [cfg.again ?? '1']: 'again',
      [cfg.hard  ?? '2']: 'hard',
      [cfg.good  ?? '3']: 'good',
      [cfg.easy  ?? '4']: 'easy',
      'j': 'again',
      'k': 'hard',
      'l': 'good',
      ';': 'easy',
    };
    if (ratingMap[e.key]) {
      rateCard(ratingMap[e.key]);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

async function init() {
  bindDOM();

  // Probe the Python bridge. If present, hydrate localStorage from the per-user
  // data dir BEFORE reading any keys (survives a localStorage wipe / reinstall),
  // and reveal the edit-mode toggle.
  await Bridge.probe();
  if (Bridge.available) {
    await hydrateFromAppData();
    if (DOM.filterEditMode) DOM.filterEditMode.hidden = false;
  }

  // Restore theme
  const savedTheme = localStorage.getItem(THEME_KEY) ?? 'lamp';
  currentThemeIdx  = Math.max(0, THEMES.indexOf(savedTheme));
  applyTheme(savedTheme);

  // Restore caps
  const savedCaps = loadCaps();
  if (savedCaps) Object.assign(App.caps, savedCaps);

  // Load config
  App.config = await loadConfig();
  App.fsrs   = new FSRS(App.config.fsrs ?? {});
  App.lang   = App.config.ui?.language ?? 'pt';

  // Config caps as default (unless user overrode)
  if (!savedCaps) {
    App.caps.new_per_day = App.config.schedule?.new_cards_per_day ?? 10;
    App.caps.rev_per_day = App.config.schedule?.review_cap_per_day ?? 50;
  }

  // Config theme overrides saved theme on fresh config load
  if (App.config.ui?.theme && !localStorage.getItem(THEME_KEY)) {
    const t = App.config.ui.theme;
    currentThemeIdx = Math.max(0, THEMES.indexOf(t));
    applyTheme(t);
  }

  // Load all deck JSONs in parallel
  App.decks = await Promise.all(
    (App.config.decks ?? [])
      .filter(d => d.enabled !== false)
      .map(d => loadDeck(d))
  );

  renderDeckGrid();
  initSettingsPanel();

  // ── Event listeners ──────────────────────────────────────────────────

  // Back button
  DOM.btnBack?.addEventListener('click', () => {
    if (App.session) {
      saveState(App.session.slug, App.session.state);
      App.session = null;
    }
    clearInterval(_timerInterval);
    document.documentElement.style.removeProperty('--deck-accent');
    if (DOM.nowStudyingBar) DOM.nowStudyingBar.classList.add('now-studying-bar--hidden');
    showView('home');
    renderDeckGrid();
  });

  // Flip button & card click
  DOM.btnFlip?.addEventListener('click', flipCard);
  DOM.flashcard?.addEventListener('click', () => {
    if (App.session && !App.session.flipped) flipCard();
  });

  // Rating buttons
  document.querySelectorAll('.btn-rating').forEach(btn => {
    btn.addEventListener('click', () => rateCard(btn.dataset.rating));
  });

  // Theme cycle button
  DOM.themeToggle?.addEventListener('click', cycleTheme);

  // Settings
  DOM.settingsToggle?.addEventListener('click', openSettings);
  DOM.settingsClose?.addEventListener('click', closeSettings);
  DOM.settingsOverlay?.addEventListener('click', closeSettings);

  // Done screen actions
  DOM.btnBackHome?.addEventListener('click', () => {
    document.documentElement.style.removeProperty('--deck-accent');
    showView('home');
    renderDeckGrid();
  });

  // Stats navigation
  DOM.btnStatsNav?.addEventListener('click', () => {
    renderStats();
    showView('stats');
  });
  DOM.btnStatsBack?.addEventListener('click', () => {
    showView('home');
    renderDeckGrid();
  });

  // Filter chips
  document.querySelectorAll('.filter-chip[data-filter]').forEach(chip => {
    chip.addEventListener('click', () => {
      const slug = App.session?.slug ?? DOM.filterBar?.dataset?.slug;
      if (!slug) return;
      const mode = chip.dataset.filter;
      const bloco = DOM.filterBloco?.value ?? '';
      startStudy(slug, {
        filterMode:  mode,
        filterBloco: bloco,
        sampleN:     0,
      });
    });
  });

  DOM.filterBloco?.addEventListener('change', () => {
    const slug = App.session?.slug ?? DOM.filterBar?.dataset?.slug;
    if (!slug) return;
    const mode  = document.querySelector('.filter-chip--active')?.dataset?.filter ?? 'all';
    const bloco = DOM.filterBloco.value;
    startStudy(slug, { filterMode: mode, filterBloco: bloco, sampleN: 0 });
  });

  DOM.filterSample?.addEventListener('click', () => {
    const slug = App.session?.slug ?? DOM.filterBar?.dataset?.slug;
    if (!slug) return;
    const mode  = document.querySelector('.filter-chip--active')?.dataset?.filter ?? 'all';
    const bloco = DOM.filterBloco?.value ?? '';
    startStudy(slug, { filterMode: mode, filterBloco: bloco, sampleN: 10 });
  });

  // Keyboard hint footer dismiss
  DOM.kbHintDismiss?.addEventListener('click', () => {
    localStorage.setItem(KB_HINT_KEY, '1');
    if (DOM.kbHintFooter) DOM.kbHintFooter.classList.add('kb-hint-footer--hidden');
  });

  // Edit mode + card editor wiring
  DOM.filterEditMode?.addEventListener('click', toggleEditMode);
  DOM.btnNewCard?.addEventListener('click', () => {
    const slug = App.session?.slug ?? DOM.filterBar?.dataset?.slug;
    if (!slug) { toast(App.lang === 'en' ? 'Open a deck first.' : 'Abra um deck primeiro.'); return; }
    openEditor('create', slug, null);
  });
  DOM.btnEditCurrent?.addEventListener('click', () => {
    if (!App.session) return;
    const card = App.session.queue[App.session.index];
    if (card) openEditor('edit', App.session.slug, card);
  });
  DOM.btnDeleteCurrent?.addEventListener('click', deleteCurrentCard);
  DOM.editorClose?.addEventListener('click', closeEditor);
  DOM.editorCancel?.addEventListener('click', closeEditor);
  DOM.editorOverlay?.addEventListener('click', closeEditor);
  DOM.editorSave?.addEventListener('click', saveEditor);
  DOM.editorCopy?.addEventListener('click', copyEditorYaml);

  // Keyboard
  document.addEventListener('keydown', handleKeydown);

  showView('home');
}

document.addEventListener('DOMContentLoaded', init);
