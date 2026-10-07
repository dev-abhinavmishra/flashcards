/* ============================================================
   flashcards — a link-sharable flashcard app
   Multi-deck library · Review / Learn / Quiz / Write modes
   Decks persist in localStorage; share links carry the deck in
   the URL (?d= LZ-String), so nothing needs a server.
   ============================================================ */
'use strict';

/* ---------------- storage ---------------- */

/* storage keys keep the original 'cardfile' prefix so existing libraries survive the rename */
const STORE_KEY = 'cardfile.decks.v1';
const LAST_KEY = 'cardfile.lastDeck';
const THEME_KEY = 'cardfile.theme';
const MOTION_KEY = 'cardfile.motion';

const URL_SAFE_LIMIT = 8000;
const URL_HARD_LIMIT = 30000;

const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

const state = {
  decks: {},            // id -> deck
  currentId: null,
  mode: 'review',       // review | learn | quiz | write | cards
  starredOnly: false,
  review: { order: [], idx: 0, flipped: false, shuffled: false },
  learn: { queue: [], total: 0, known: 0, passes: 0, done: false, missed: [] },
  quiz: { order: [], idx: 0, correct: 0, answered: false, missed: [] },
  write: { order: [], idx: 0, correct: 0, checked: false, missed: [] },
  search: '',
  libSearch: '',
};

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) state.decks = JSON.parse(raw) || {};
  } catch { state.decks = {}; }
}

function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state.decks)); } catch {}
}

const deck = () => state.decks[state.currentId] || null;

function newCard(q, a, ex) {
  return { id: uid(), q: q || '', a: a || '', ex: ex || '', starred: false, status: 'new' };
}

function createDeck(title, cards) {
  const d = {
    id: uid(),
    title: title || 'Untitled deck',
    cards: cards || [],
    flipped: false,
    createdAt: Date.now(),
    lastStudiedAt: 0,
  };
  state.decks[d.id] = d;
  return d;
}

/* ---------------- text helpers ---------------- */

// Diacritic shorthand kept from the original tool: a vowel followed by
// ^, _, or ` becomes a macron vowel; ´ becomes acute; a combining breve
// becomes a breve vowel. Every input is fully transformed — the old guard
// that skipped strings already containing macrons left literal shorthand
// behind on mixed cards.
const MACRON = { a: 'ā', e: 'ē', i: 'ī', o: 'ō', u: 'ū', A: 'Ā', E: 'Ē', I: 'Ī', O: 'Ō', U: 'Ū' };
const BREVE = { a: 'ă', e: 'ĕ', i: 'ĭ', o: 'ŏ', u: 'ŭ', A: 'Ă', E: 'Ĕ', I: 'Ĭ', O: 'Ŏ', U: 'Ŭ' };
const ACUTE = { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú' };

function diacritics(text) {
  if (!text) return text || '';
  return text
    .replace(/([aeiouAEIOU])[\^_`]/g, (m, v) => MACRON[v] || m)
    .replace(/([aeiouAEIOU])´/g, (m, v) => ACUTE[v] || m)
    .replace(/([aeiouAEIOU])̆/g, (m, v) => BREVE[v] || m)
    .normalize('NFC');
}

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function relTime(ts) {
  if (!ts) return 'never studied';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

const norm = s => String(s || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ')
  .replace(/\s+/g, ' ').trim();

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/* ---------------- card motion ---------------- */

// motion preference: 'auto' follows the OS reduced-motion flag, 'on' forces
// all animation, 'off' suppresses it — picked from the header toggle.
const osReduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
let motionPref = (() => { try { return localStorage.getItem(MOTION_KEY) || 'auto'; } catch { return 'auto'; } })();
function motionReduced() {
  if (motionPref === 'on') return false;
  if (motionPref === 'off') return true;
  return osReduceMQ.matches;
}
function applyMotionPref(pref) {
  motionPref = pref;
  try { localStorage.setItem(MOTION_KEY, pref); } catch {}
  if (pref === 'auto') document.documentElement.removeAttribute('data-motion');
  else document.documentElement.setAttribute('data-motion', pref);
  const btn = $('motion-btn');
  if (btn) {
    btn.dataset.state = pref;
    const label = pref === 'auto'
      ? `Motion: follows system (${osReduceMQ.matches ? 'reduced' : 'on'})`
      : pref === 'on' ? 'Motion: always on' : 'Motion: reduced';
    btn.title = label + ' — click to change';
    btn.setAttribute('aria-label', label);
  }
}
const cardMotion = { busy: false, pending: null, gen: 0 };

// Directional card swap: the current card flicks off in the direction of
// travel (dir 1 = exits right, -1 = exits left) and the next card slides
// in from the opposite side. swap() runs while the card is off-screen.
// Rapid presses queue the latest intent instead of piling up.
function slideCard(wrap, dir, swap) {
  if (motionReduced() || !wrap) { swap(); return; }
  if (cardMotion.busy) { cardMotion.pending = { wrap, dir, swap }; return; }
  cardMotion.busy = true;
  // the deck may change while the exit flies — a stale swap must not
  // reach into the new session's queues
  const gen = cardMotion.gen;
  const finish = () => {
    cardMotion.busy = false;
    const p = cardMotion.pending; cardMotion.pending = null;
    if (p) slideCard(p.wrap, p.dir, p.swap);
  };
  const exit = wrap.animate([
    { transform: 'translateX(0) translateY(0) rotate(0deg)', opacity: 1 },
    { transform: `translateX(${dir * 9}%) translateY(-4px) rotate(${dir * 1.5}deg)`, opacity: .9, offset: .28 },
    { transform: `translateX(${dir * 64}%) translateY(16px) rotate(${dir * 5}deg)`, opacity: 0 },
  ], { duration: 240, easing: 'cubic-bezier(.55,.06,.68,.19)', fill: 'forwards' });
  exit.finished.catch(() => {}).then(() => {
    exit.cancel();
    if (gen !== cardMotion.gen) { finish(); return; }
    swap();
    const enter = wrap.animate([
      { transform: `translateX(${-dir * 64}%) translateY(-10px) rotate(${-dir * 5}deg)`, opacity: 0 },
      { transform: `translateX(${-dir * 9}%) translateY(-2px) rotate(${-dir * 1.5}deg)`, opacity: .95, offset: .72 },
      { transform: 'translateX(0) translateY(0) rotate(0deg)', opacity: 1 },
    ], { duration: 380, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'forwards' });
    enter.finished.catch(() => {}).then(() => { enter.cancel(); finish(); });
  });
}

// A real flip: the card rises toward the viewer (translateZ under the
// wrap's perspective), tips slightly edge-on, and settles on the new face.
// The .flipped class is the state source of truth; WAAPI draws the arc.
function flipCardEl(wrap, on) {
  if (!wrap) return;
  const inner = wrap.firstElementChild;
  const was = wrap.classList.contains('flipped');
  const to = on === undefined ? !was : !!on;
  if (was === to) return;
  wrap.classList.toggle('flipped', to);
  if (motionReduced() || !inner) return;
  const from = was ? 180 : 0, deg = to ? 180 : 0;
  inner.style.transition = 'none';
  inner.getAnimations().forEach(a => a.cancel());
  wrap.classList.add('is-flipping');
  const anim = inner.animate([
    { transform: `rotateY(${from}deg) translateZ(0)`, offset: 0 },
    { transform: `rotateY(${from + (deg - from) * .5}deg) rotateX(6deg) translateZ(64px)`, offset: .5 },
    { transform: `rotateY(${deg}deg) translateZ(0)`, offset: 1 },
  ], { duration: 520, easing: 'cubic-bezier(.24,.9,.3,1)', fill: 'forwards' });
  anim.finished.catch(() => {}).then(() => {
    anim.cancel();
    inner.style.transition = '';
    wrap.classList.remove('is-flipping');
  });
}

// Back to the front face with no animation — used while the card is
// off-screen mid-swap, so the entering card never arrives spun around.
function unflipNow(wrap) {
  if (!wrap) return;
  const inner = wrap.firstElementChild;
  if (inner) { inner.style.transition = 'none'; inner.getAnimations().forEach(a => a.cancel()); }
  wrap.classList.remove('flipped', 'is-flipping');
  if (inner) { void inner.offsetWidth; inner.style.transition = ''; }
}

/* ---------------- confetti ---------------- */

// Paper bits erupting from launchers along the bottom edge — staggered
// volleys, launch flashes, fluttering ribbons and punched-paper dots.
// Colors come from the live theme tokens, so it matches light/dark.
function spawnConfetti({ bursts, power = 1, life = 115 }) {
  if (motionReduced()) return;
  const cv = document.createElement('canvas');
  cv.className = 'confetti-layer';
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = innerWidth * dpr;
  cv.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const palette = ['--blue', '--red', '--yellow', '--green', '--card']
    .map(k => css.getPropertyValue(k).trim()).filter(Boolean);
  const parts = [];
  const emit = b => {
    for (let i = 0; i < b.count; i++) {
      const rad = (b.angle + (Math.random() - .5) * b.spread) * Math.PI / 180;
      const v = (11 + Math.random() * 7.5) * power;
      const kind = Math.random() < .22 ? 'ribbon' : Math.random() < .2 ? 'dot' : 'rect';
      parts.push({
        kind,
        // spawn just offscreen — an oversized fraction times a very tall
        // viewport must not land past the cull margin
        x: b.x * innerWidth, y: Math.min(b.y * innerHeight, innerHeight + 40),
        vx: Math.cos(rad) * v, vy: Math.sin(rad) * v,
        w: kind === 'ribbon' ? 2.6 : 4 + Math.random() * 4.5,
        h: kind === 'ribbon' ? 9 + Math.random() * 6 : 3 + Math.random() * 4,
        r: 1.6 + Math.random() * 1.6,
        rot: Math.random() * Math.PI * 2, vr: (Math.random() - .5) * .3,
        sa: .3 + Math.random() * .9,      // flutter amplitude
        sf: .06 + Math.random() * .08,    // flutter frequency
        sp: Math.random() * Math.PI * 2,  // flutter phase
        g: kind === 'ribbon' ? .1 : .15,  // ribbons drift down lighter
        c: palette[(Math.random() * palette.length) | 0] || '#1f47b8',
        t: 0, ttl: life * (.7 + Math.random() * .6),
      });
    }
    // a soft ring where the launcher fires
    parts.push({ kind: 'flash', x: b.x * innerWidth, y: Math.min(b.y, 1) * innerHeight, t: 0, ttl: 12 });
  };
  let frame = 0, raf = 0;
  const lastAt = Math.max(...bursts.map(b => b.at));
  const step = () => {
    for (const b of bursts) if (b.at === frame) emit(b);
    frame++;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    let alive = false;
    for (const p of parts) {
      if (p.t > p.ttl) continue;
      alive = true;
      p.t++;
      if (p.kind === 'flash') {
        const r = 6 + p.t * 5, a = .4 * (1 - p.t / p.ttl);
        ctx.save();
        ctx.globalAlpha = Math.max(a, 0);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        continue;
      }
      p.vy += p.g;
      p.vx *= .985; p.vy *= .992;              // air drag
      p.x += p.vx + Math.sin(p.t * p.sf + p.sp) * p.sa;
      p.y += p.vy;
      p.rot += p.vr;
      if (p.y > innerHeight + 60) { p.t = p.ttl; continue; }
      const fade = p.t > p.ttl - 24 ? (p.ttl - p.t) / 24 : 1;
      ctx.save();
      ctx.globalAlpha = Math.max(fade, 0);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      if (p.kind === 'dot') { ctx.beginPath(); ctx.arc(0, 0, p.r, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (alive || frame <= lastAt) raf = requestAnimationFrame(step);
    else cv.remove();
  };
  raf = requestAnimationFrame(step);
  setTimeout(() => { cancelAnimationFrame(raf); cv.remove(); }, 6000);  // safety for hidden tabs
}

// Finishing a set: corner launchers cross-fire over the results card,
// then a center volley. A perfect score earns a second round.
function celebrateSet(pct) {
  const strong = pct === 100;
  const bursts = [
    { at: 0,  x: .16, y: 1.03, angle: -64,  spread: 22, count: strong ? 64 : 52 },
    { at: 0,  x: .84, y: 1.03, angle: -116, spread: 22, count: strong ? 64 : 52 },
    { at: 18, x: .34, y: 1.03, angle: -76,  spread: 16, count: 30 },
    { at: 18, x: .66, y: 1.03, angle: -104, spread: 16, count: 30 },
    { at: 40, x: .5,  y: 1.03, angle: -90,  spread: 28, count: strong ? 48 : 30 },
  ];
  if (strong) bursts.push(
    { at: 58, x: .16, y: 1.03, angle: -64,  spread: 20, count: 28 },
    { at: 58, x: .84, y: 1.03, angle: -116, spread: 20, count: 28 });
  spawnConfetti({ bursts });
}

// A small puff off an element — the correct-answer moment.
function sprinkleFrom(el) {
  if (!el || motionReduced()) return;
  const r = el.getBoundingClientRect();
  spawnConfetti({
    power: .34, life: 52,
    bursts: [{
      at: 0,
      x: (r.left + r.width / 2) / innerWidth,
      y: (r.top + r.height / 2) / innerHeight,
      angle: -90, spread: 110, count: 12,
    }],
  });
}

const CHECK_SVG = `<svg class="opt-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.6l3.1 3L13 4.6"/></svg>`;

/* ---------------- dom ---------------- */

const $ = id => document.getElementById(id);
const els = {
  deckList: $('deck-list'), libraryCount: $('library-count'),
  emptyStage: $('empty-stage'), deckView: $('deck-view'),
  deckTitle: $('deck-title'), deckMeta: $('deck-meta'),
  cardsTabCount: $('cards-tab-count'),
  veil: $('modal-veil'), modalBox: $('modal-box'),
  toast: $('toast'), printSheet: $('print-sheet'),
};

let toastTimer = null;
function toast(msg, ms = 2200) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

/* ---------------- modal ---------------- */

function openModal(html, { wide = false } = {}) {
  els.modalBox.className = 'modal' + (wide ? ' wide' : '');
  els.modalBox.innerHTML = html;
  els.veil.hidden = false;
  const first = els.modalBox.querySelector('input, textarea, [data-close]');
  if (first) setTimeout(() => first.focus(), 30);
  els.modalBox.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
}
function closeModal() { els.veil.hidden = true; els.modalBox.innerHTML = ''; }
els.veil.addEventListener('mousedown', e => { if (e.target === els.veil) closeModal(); });

function confirmModal(title, body, confirmLabel, onConfirm, danger = true) {
  openModal(`
    <h3>${esc(title)}</h3>
    <p class="modal-sub">${body}</p>
    <div class="modal-actions">
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" id="cf-ok">${esc(confirmLabel)}</button>
    </div>`);
  $('cf-ok').addEventListener('click', () => { closeModal(); onConfirm(); });
}

function promptModal(title, label, initial, onSubmit) {
  openModal(`
    <h3>${esc(title)}</h3>
    <label class="field-label" for="pm-input">${esc(label)}</label>
    <input class="field-input" id="pm-input" value="${esc(initial)}" maxlength="140">
    <div class="modal-actions">
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn primary" id="pm-ok">Save</button>
    </div>`);
  const input = $('pm-input');
  const go = () => { const v = input.value.trim(); if (v) { closeModal(); onSubmit(v); } };
  $('pm-ok').addEventListener('click', go);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  input.select();
}

/* ---------------- deck url codec (v2 + v1 + legacy) ---------------- */

function encodeDeckV2(title, cards) {
  const RS = '\x1E', US = '\x1F';
  const parts = [title || ''];
  for (const c of cards) {
    const ex = c.ex && c.ex !== '(Example text not provided)' ? c.ex : '';
    parts.push([c.q || '', c.a || '', ex].join(US));
  }
  return LZString.compressToEncodedURIComponent(parts.join(RS));
}

function decodeDeckV2(encoded) {
  try {
    const raw = LZString.decompressFromEncodedURIComponent(encoded);
    if (!raw) return null;
    const RS = '\x1E', US = '\x1F';
    const records = raw.split(RS);
    const title = records.shift() || 'Shared deck';
    const cards = records.map(rec => {
      const [question = '', definition = '', example = ''] = rec.split(US);
      return { q: question, a: definition, ex: example };
    }).filter(c => c.q && c.a);
    if (!cards.length) return null;
    return { title, cards };
  } catch { return null; }
}

// v1: base64-encoded JSON {t, c:[[q,a,ex],...]}
function decompressV1(data) {
  try {
    const obj = JSON.parse(decodeURIComponent(atob(data)));
    const cards = (Array.isArray(obj.c) ? obj.c : []).map(c => ({ q: c[0], a: c[1], ex: c[2] || '' }))
      .filter(c => c.q && c.a);
    if (!cards.length) return null;
    return { title: obj.t, cards };
  } catch { return null; }
}

function deckFingerprint(title, cards) {
  let h = 0;
  const s = cards.map(c => `${c.q}\x00${c.a}`).join('\x01');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${title}|${cards.length}|${h}`;
}

/** Import a shared-link deck into the library (deduped), select it. */
function importSharedDeck(title, rawCards) {
  rawCards = rawCards.filter(c => c && c.q && c.a)
    .map(c => ({ q: diacritics(c.q), a: diacritics(c.a), ex: diacritics(c.ex) }));
  if (!rawCards.length) { toast('That link had no usable cards in it.'); return; }
  // fingerprint on the converted text so a link carrying shorthand
  // still dedupes against the repaired stored deck
  const fp = deckFingerprint(title, rawCards);
  const existing = Object.values(state.decks).find(d =>
    deckFingerprint(d.title, d.cards.map(c => ({ q: c.q, a: c.a }))) === fp);
  if (existing) { selectDeck(existing.id); toast('Deck already in your library'); return; }
  const d = createDeck(title, rawCards.map(c => newCard(c.q, c.a, c.ex)));
  saveStore();
  selectDeck(d.id);
  toast(`Imported “${d.title}” — ${d.cards.length} cards`);
}

function parseUrlDeck() {
  const p = new URLSearchParams(location.search);
  const v2 = p.get('d'), v1 = p.get('data'), deckKey = p.get('deck');
  const cardsParam = p.get('cards'), titleParam = p.get('title');
  const wantsShuffle = p.get('shuffle') === '1';
  const applyShuffle = () => {
    if (!wantsShuffle || !deck() || deck().cards.length < 2) return;
    state.review.order = shuffleInPlace(state.review.order.slice());
    state.review.shuffled = true;
  };

  if (v2) {
    const d = decodeDeckV2(v2);
    if (d) { importSharedDeck(d.title, d.cards); applyShuffle(); }
    else toast('Couldn’t read that link — it may be truncated.');
    history.replaceState(null, '', location.pathname);
    return true;
  }
  if (v1) {
    const d = decompressV1(v1);
    if (d) { importSharedDeck(d.title, d.cards); applyShuffle(); }
    else toast('Couldn’t read that link — it may be corrupted.');
    history.replaceState(null, '', location.pathname);
    return true;
  }
  if (deckKey) {
    try {
      const stored = localStorage.getItem(deckKey);
      if (stored) {
        const obj = JSON.parse(stored);
        importSharedDeck(obj.title, obj.cards.map(c =>
          ({ q: c.question ?? c.q, a: c.definition ?? c.a, ex: c.example ?? c.ex })));
        applyShuffle();
      } else toast('That stored deck is gone — ask for a fresh link.');
    } catch { toast('Failed to load stored deck.'); }
    history.replaceState(null, '', location.pathname);
    return true;
  }
  if (cardsParam) {
    try {
      const cards = decodeURIComponent(cardsParam).split(';').map(entry => {
        const [main, ex = ''] = entry.split('|').map(s => s.trim());
        const i = main.indexOf(':');
        if (i < 0) return null;
        const q = main.slice(0, i).trim(), a = main.slice(i + 1).trim();
        return q && a ? { q, a, ex } : null;
      }).filter(Boolean);
      if (cards.length) {
        importSharedDeck(titleParam ? decodeURIComponent(titleParam) : 'Shared deck', cards);
      }
    } catch { toast('Bad card data in link.'); }
    history.replaceState(null, '', location.pathname);
    return true;
  }
  return false;
}

/* ---------------- library rendering ---------------- */

function deckStats(d) {
  const total = d.cards.length;
  const starred = d.cards.filter(c => c.starred).length;
  const mastered = d.cards.filter(c => c.status === 'mastered').length;
  const learning = d.cards.filter(c => c.status === 'learning').length;
  return { total, starred, mastered, learning };
}

function renderLibrary() {
  const q = norm(state.libSearch);
  const ids = Object.keys(state.decks)
    .filter(id => !q || norm(state.decks[id].title).includes(q))
    .sort((a, b) =>
      (state.decks[b].lastStudiedAt || state.decks[b].createdAt) - (state.decks[a].lastStudiedAt || state.decks[a].createdAt));
  els.libraryCount.textContent = ids.length ? `${ids.length} deck${ids.length === 1 ? '' : 's'}` : '';
  const clb = $('clear-lib-btn'); if (clb) clb.disabled = !Object.keys(state.decks).length;
  if (!ids.length) {
    els.deckList.innerHTML = q
      ? `<div class="deck-hint">no decks match “${esc(state.libSearch)}”</div>`
      : `<div class="deck-hint">no decks yet —<br>“New deck” starts one,<br>“Import…” brings cards in</div>`;
    return;
  }
  els.deckList.innerHTML = ids.map(id => {
    const d = state.decks[id];
    const s = deckStats(d);
    return `
      <div class="deck-row ${id === state.currentId ? 'active' : ''}" data-deck="${id}">
        <button class="dr-main">
          <span class="dr-title">${esc(d.title)}</span>
          <span class="dr-meta"><span>${s.total} card${s.total === 1 ? '' : 's'}${s.starred ? ` · ${s.starred}★` : ''}</span><span>${relTime(d.lastStudiedAt)}</span></span>
          <span class="dr-bar"><i style="width:${s.total ? (s.mastered / s.total * 100) : 0}%"></i></span>
        </button>
        <button class="dr-kebab" data-kebab="${id}" title="Deck actions" aria-label="Actions for ${esc(d.title)}">⋮</button>
      </div>`;
  }).join('');
  els.deckList.querySelectorAll('.dr-main').forEach(btn =>
    btn.addEventListener('click', () => selectDeck(btn.closest('.deck-row').dataset.deck)));
  els.deckList.querySelectorAll('.dr-kebab').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); openRowMenu(btn.dataset.kebab, btn); }));
}

let rowMenuFor = null;
function openRowMenu(id, anchor) {
  const menu = $('row-menu');
  if (!menu.hidden && rowMenuFor === id) { menu.hidden = true; rowMenuFor = null; return; }
  const d = state.decks[id]; if (!d) return;
  rowMenuFor = id;
  menu.innerHTML = `
    <button data-act="rename">Rename…</button>
    <button data-act="dup">Duplicate</button>
    <button data-act="export">Export .json</button>
    <hr>
    <button class="danger" data-act="del">Delete…</button>`;
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(r.bottom + 3, innerHeight - menu.offsetHeight - 8)}px`;
  menu.querySelectorAll('button[data-act]').forEach(b =>
    b.addEventListener('click', () => { menu.hidden = true; rowMenuAction(id, b.dataset.act); }));
}

function rowMenuAction(id, act) {
  const d = state.decks[id]; if (!d) return;
  rowMenuFor = null;
  if (act === 'rename') {
    promptModal('Rename deck', 'Deck title', d.title, v => {
      d.title = v; saveStore();
      if (id === state.currentId) renderAll(); else renderLibrary();
    });
  } else if (act === 'dup') {
    createDeck(`${d.title} (copy)`, d.cards.map(c => newCard(c.q, c.a, c.ex)));
    saveStore(); renderLibrary();
    toast('Deck duplicated');
  } else if (act === 'export') {
    exportJson(d);
  } else if (act === 'del') {
    confirmModal('Delete this deck?', `“${esc(d.title)}” and its ${d.cards.length} cards will be removed from this browser. Anyone with the share link keeps their copy.`, 'Delete deck', () => {
      delete state.decks[id];
      saveStore();
      if (id === state.currentId) {
        const remaining = Object.keys(state.decks)[0];
        if (remaining) selectDeck(remaining);
        else { state.currentId = null; localStorage.removeItem(LAST_KEY); renderAll(); }
      } else renderLibrary();
      toast('Deck deleted');
    });
  }
}

/* ---------------- selection & study set ---------------- */

function studyCards(d) {
  const list = d.cards.filter(c => !state.starredOnly || c.starred);
  return list;
}

function selectDeck(id, mode) {
  state.currentId = id;
  state.mode = mode || 'review';
  localStorage.setItem(LAST_KEY, id);
  const d = deck();
  if (d) { d.lastStudiedAt = Date.now(); saveStore(); }
  resetSessions();
  renderAll();
}

function resetSessions() {
  const d = deck();
  const cards = d ? studyCards(d) : [];
  const order = cards.map(c => c.id);
  state.review = { order, idx: 0, flipped: false, shuffled: false };
  state.learn = { queue: shuffleInPlace([...order]), total: order.length, known: 0, passes: 0, done: false, missed: [] };
  state.quiz = { order: shuffleInPlace([...order]), idx: 0, correct: 0, answered: false, missed: [] };
  state.write = { order: shuffleInPlace([...order]), idx: 0, correct: 0, checked: false, missed: [] };
  state.search = '';
  state.statPrev = null;   // strip bumps only compare within this deck
  cardMotion.gen++;        // any in-flight slide belongs to the old session
  cardMotion.pending = null;
  const s = $('card-search'); if (s) s.value = '';
}

function renderAll() {
  renderLibrary();
  const d = deck();
  const empty = !d;
  els.emptyStage.hidden = !empty;
  els.deckView.hidden = empty;
  if (!d) { document.title = 'flashcards — decks that live in a link'; return; }

  // drop ids that no longer exist (cards may have been deleted)
  const live = new Set(d.cards.map(c => c.id));
  state.review.order = state.review.order.filter(id => live.has(id));
  state.learn.queue = state.learn.queue.filter(id => live.has(id));
  state.learn.total = Math.min(state.learn.total, live.size);
  state.quiz.order = state.quiz.order.filter(id => live.has(id));
  state.write.order = state.write.order.filter(id => live.has(id));
  state.review.idx = Math.min(state.review.idx, Math.max(0, state.review.order.length - 1));

  document.title = `${d.title} — flashcards`;
  els.deckTitle.textContent = d.title;
  const s = deckStats(d);
  els.deckMeta.innerHTML =
    `<span><b>${s.total}</b> card${s.total === 1 ? '' : 's'}</span>` +
    `<span><b>${s.mastered}</b> mastered</span>` +
    `<span>${relTime(d.lastStudiedAt)}</span>` +
    (d.flipped ? `<span>sides swapped</span>` : '');
  els.cardsTabCount.textContent = `(${s.total})`;

  const pill = $('starred-filter');
  pill.classList.toggle('on', state.starredOnly);
  pill.innerHTML = `<i class="dot"></i>Starred${state.starredOnly ? ` (${s.starred})` : ' only'}`;

  document.querySelectorAll('.mode-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.mode === state.mode));
  positionTabInk();

  for (const m of ['review', 'learn', 'quiz', 'write', 'cards'])
    $(`stage-${m}`).hidden = state.mode !== m;

  if (state.mode === 'review') renderReview();
  else if (state.mode === 'learn') renderLearn();
  else if (state.mode === 'quiz') renderQuiz();
  else if (state.mode === 'write') renderWrite();
  else renderEditor();
}

function statStripHTML(d) {
  const s = deckStats(d);
  const prev = state.statPrev || {};
  state.statPrev = { mastered: s.mastered, learning: s.learning, starred: s.starred };
  // a number that just rose pops briefly in its own color
  const bump = (k, c) => (prev[k] !== undefined && s[k] > prev[k]
    ? ` bump" style="--bump-c:var(--${c})` : '');
  return `
    <div class="stat"><div class="sv">${s.total}</div><div class="sl">cards</div></div>
    <div class="stat"><div class="sv${bump('mastered', 'green')}"><span class="hl">${s.mastered}</span></div><div class="sl">mastered</div></div>
    <div class="stat"><div class="sv${bump('learning', 'red')}">${s.learning}</div><div class="sl">learning</div></div>
    <div class="stat starred"><div class="sv${bump('starred', 'yellow')}">${s.starred}</div><div class="sl">starred</div></div>`;
}

let inkPlaced = false;
function positionTabInk() {
  const ink = $('tab-ink');
  const tab = document.querySelector('.mode-tab.active');
  if (!ink || !tab) return;
  // first placement is instant — only later moves should visibly slide.
  // while the tab row is hidden (welcome screen) width is 0 — don't count that.
  const placed = inkPlaced && tab.offsetWidth > 0;
  if (!placed) ink.style.transition = 'none';
  ink.style.left = `${tab.offsetLeft}px`;
  ink.style.width = `${tab.offsetWidth}px`;
  if (!placed) { void ink.offsetWidth; ink.style.transition = ''; }
  if (tab.offsetWidth > 0) inkPlaced = true;
}

function frontText(c) { return deck().flipped ? c.a : c.q; }
function backText(c) { return deck().flipped ? c.q : c.a; }

function emptyStudySet(prefix) {
  // placeholder card content when a mode has nothing to show
  return prefix === 'No starred cards'
    ? 'Star cards with B while reviewing, or turn off the starred filter.'
    : 'Add cards in the Cards tab, or import a deck.';
}

/* ---------------- REVIEW ---------------- */

function reviewCard() {
  const d = deck();
  const c = d && d.cards.find(c => c.id === state.review.order[state.review.idx]);
  return c || null;
}

function renderReview(anim) {
  const d = deck();
  if (!d) return;

  const wrap = $('card-wrap');
  const order = state.review.order;
  const n = order.length;
  // A held arrow key queues slides whose swaps mutate idx after the
  // click-time bound check — clamp before rendering so an overshoot
  // can never show a phantom or empty state mid-deck.
  state.review.idx = Math.min(Math.max(0, state.review.idx), Math.max(0, n - 1));
  const c = reviewCard();
  const s = deckStats(d);
  $('rev-mastered').textContent = `${s.mastered} mastered`;

  const emptyEl = $('review-empty');
  if (!c) {
    $('rev-count').textContent = `0 / ${n}`;
    $('rev-progress').style.width = '0%';
    wrap.style.display = 'none';
    emptyEl.hidden = false;
    emptyEl.textContent = state.starredOnly && d.cards.length
      ? `No starred cards — ${emptyStudySet('No starred cards')}`
      : `No cards to show — ${emptyStudySet('')}`;
    $('star-btn').style.visibility = 'hidden';
    $('prev-btn').disabled = true;
    $('next-btn').disabled = true;
    $('flip-pill').disabled = true;
    $('review-stats').innerHTML = statStripHTML(d);
    return;
  }

  wrap.style.display = '';
  emptyEl.hidden = true;
  $('flip-pill').disabled = false;
  $('star-btn').style.visibility = '';
  $('rev-count').textContent = `${state.review.idx + 1} / ${n}`;
  $('rev-progress').style.width = `${((state.review.idx + 1) / n * 100)}%`;
  const corner = `${String(state.review.idx + 1).padStart(2, '0')}`;
  $('card-corner').textContent = corner;
  $('card-corner-b').textContent = corner;
  $('front-label').textContent = d.flipped ? 'Answer first — recall the term' : 'Term';
  $('back-label').textContent = 'Answer';
  $('card-front-text').textContent = frontText(c);
  $('card-back-def').textContent = backText(c);
  $('card-back-ex').textContent = c.ex || '';
  $('back-hint').textContent = c.status === 'mastered' ? 'marked mastered' : c.status === 'learning' ? 'still learning' : '';

  $('star-btn').classList.toggle('starred', !!c.starred);
  $('star-btn').innerHTML = `<svg viewBox="0 0 24 24" fill="${c.starred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7-6.2-3.7-6.2 3.7 1.6-7L2 9.2l7.1-.6z"/></svg>`;

  $('prev-btn').disabled = state.review.idx === 0;
  $('next-btn').disabled = state.review.idx >= n - 1;
  $('shuffle-pill').classList.toggle('on', state.review.shuffled);
  $('sides-pill').classList.toggle('on', d.flipped);

  if (state.review.flipped) { unflipNow(wrap); state.review.flipped = false; }

  wrap.classList.remove('deal');
  void wrap.offsetWidth;
  if (anim !== 'slide') wrap.classList.add('deal');

  $('review-stats').innerHTML = statStripHTML(d);
}

/* ---------------- LEARN ---------------- */

function learnCard() {
  const d = deck();
  return d ? d.cards.find(c => c.id === state.learn.queue[0]) || null : null;
}

function renderLearn(anim) {
  const d = deck(); if (!d) return;
  const L = state.learn;
  const wrap = $('learn-wrap');

  const learnEmptyEl = $('learn-empty');
  if (L.total === 0) {
    $('learn-count').textContent = '';
    $('learn-progress').style.width = '0%';
    $('learn-round').textContent = '';
    wrap.style.display = 'none';
    learnEmptyEl.hidden = false;
    learnEmptyEl.textContent = state.starredOnly && d.cards.length
      ? `No starred cards — ${emptyStudySet('No starred cards')}`
      : `Nothing to study — ${emptyStudySet('')}`;
    $('verdict-learning').parentElement.style.visibility = 'hidden';
    $('learn-stats').innerHTML = statStripHTML(d);
    return;
  }
  wrap.style.display = '';
  learnEmptyEl.hidden = true;

  if (L.queue.length === 0) {  // session complete
    if (!L.done) { L.done = true; showLearnResults(); }
    // terminal state — without it the stage freezes on the last card
    // with a stale "1 left" and verdict buttons that do nothing
    const stillNeed = d.cards.filter(c => L.missed.includes(c.id) && c.status !== 'mastered').length;
    $('learn-count').textContent = `${L.known} / ${L.total} learned`;
    $('learn-progress').style.width = '100%';
    $('learn-round').textContent = '0 left';
    $('learn-corner').textContent = 'DONE';
    $('learn-corner-b').textContent = 'DONE';
    $('learn-front-label').textContent = 'Session complete';
    $('learn-back-label').textContent = 'Session';
    $('learn-front').textContent = 'Done.';
    $('learn-back').textContent = stillNeed ? `${stillNeed} still learning` : 'all learned';
    $('learn-ex').textContent = `${L.passes} pass${L.passes === 1 ? '' : 'es'}`;
    unflipNow(wrap);
    $('verdict-learning').parentElement.style.visibility = 'hidden';
    $('learn-stats').innerHTML = statStripHTML(d);
    return;
  }
  L.done = false;
  const c = learnCard();
  $('learn-front-label').textContent = 'Recall the answer';
  $('learn-back-label').textContent = 'Answer';
  $('verdict-learning').parentElement.style.visibility = '';
  $('learn-count').textContent = `${L.known} / ${L.total} learned`;
  $('learn-progress').style.width = `${(L.total ? L.known / L.total * 100 : 0)}%`;
  $('learn-round').textContent = `${L.queue.length} left`;
  $('learn-corner').textContent = 'LEARN';
  $('learn-corner-b').textContent = 'LEARN';
  $('learn-front').textContent = frontText(c);
  $('learn-back').textContent = backText(c);
  $('learn-ex').textContent = c.ex || '';
  unflipNow(wrap);
  wrap.classList.remove('deal'); void wrap.offsetWidth;
  if (anim !== 'slide') wrap.classList.add('deal');

  const s = deckStats(d);
  $('learn-stats').innerHTML = statStripHTML(d);
}

function learnVerdict(known) {
  const c = learnCard(); if (!c) return;
  // a card you knew flicks away to the right; one you're still learning
  // slides back into the pile on the left
  slideCard($('learn-wrap'), known ? 1 : -1, () => {
    const L = state.learn;
    c.status = known ? 'mastered' : 'learning';
    L.passes++;
    if (known) {
      L.known++;
      L.queue.shift();
    } else {
      if (!L.missed.includes(c.id)) L.missed.push(c.id);
      L.queue.push(L.queue.shift());  // requeue to end
      if (L.passes > L.total * 12) { L.queue = []; }  // safety valve
    }
    saveStore(); renderLearn('slide'); renderLibrary(); renderMeta();
  });
}

function showLearnResults() {
  const L = state.learn;
  const pct = L.total ? Math.round(L.known / L.total * 100) : 100;
  if (!L.celebrated) { L.celebrated = true; setTimeout(() => celebrateSet(pct), 140); }
  const masteredNow = L.known;
  const stillNeed = deck().cards.filter(c => L.missed.includes(c.id) && c.status !== 'mastered').length;
  openModal(`
    <h3>Session complete</h3>
    <p class="modal-sub">${esc(deck().title)} · learn mode</p>
    <div class="result-grid">
      <div class="result-cell good"><div class="rv">${masteredNow}</div><div class="rl">learned</div></div>
      <div class="result-cell ${stillNeed ? 'bad' : ''}"><div class="rv">${stillNeed}</div><div class="rl">still learning</div></div>
      <div class="result-cell"><div class="rv">${L.passes}</div><div class="rl">total passes</div></div>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" data-close>Done</button>
      ${L.missed.length ? '<button class="btn primary" id="again-missed">Review missed again</button>' : ''}
    </div>`);
  const again = $('again-missed');
  if (again) again.addEventListener('click', () => {
    closeModal();
    state.learn = { queue: shuffleInPlace([...L.missed]), total: L.missed.length, known: 0, passes: 0, done: false, missed: [] };
    renderLearn();
  });
}

/* ---------------- QUIZ ---------------- */

function quizCard() {
  const d = deck();
  return d ? d.cards.find(c => c.id === state.quiz.order[state.quiz.idx]) || null : null;
}

function renderQuiz(anim) {
  const d = deck(); if (!d) return;
  const Q = state.quiz;

  const quizEmptyEl = $('quiz-empty');
  if (!Q.order.length) {
    $('quiz-count').textContent = '';
    $('quiz-progress').style.width = '0%';
    $('quiz-score').textContent = '';
    $('quiz-wrap').style.display = 'none';
    quizEmptyEl.hidden = false;
    quizEmptyEl.textContent = state.starredOnly && d.cards.length
      ? `No starred cards — ${emptyStudySet('No starred cards')}`
      : `Nothing to quiz — ${emptyStudySet('')}`;
    $('quiz-list').innerHTML = '';
    $('quiz-msg').textContent = '';
    $('quiz-next').hidden = true;
    return;
  }
  $('quiz-wrap').style.display = '';
  quizEmptyEl.hidden = true;

  if (Q.idx >= Q.order.length) {  // session complete — terminal state
    if (!Q.done) { Q.done = true; showQuizResults(); }
    $('quiz-count').textContent = `${Q.order.length} / ${Q.order.length}`;
    $('quiz-progress').style.width = '100%';
    $('quiz-score').textContent = `${Q.correct} correct`;
    $('quiz-corner').textContent = 'DONE';
    $('quiz-front-label').textContent = 'Session complete';
    $('quiz-front').textContent = 'Done.';
    $('quiz-list').innerHTML = `<div class="quiz-opt" style="cursor:default"><span class="opt-key">·</span><span>${Q.correct} of ${Q.order.length} correct</span></div>`;
    $('quiz-msg').textContent = '';
    $('quiz-next').hidden = true;
    return;
  }
  const c = quizCard(); if (!c) return;

  Q.answered = Q.answeredId === c.id;
  $('quiz-count').textContent = `${Q.idx + 1} / ${Q.order.length}`;
  $('quiz-progress').style.width = `${((Q.idx + 1) / Q.order.length * 100)}%`;
  $('quiz-score').textContent = `${Q.correct} correct`;
  $('quiz-corner').textContent = `Q${String(Q.idx + 1).padStart(2, '0')}`;
  $('quiz-front-label').textContent = 'Which answer matches?';
  $('quiz-front').textContent = frontText(c);
  $('quiz-msg').textContent = 'Pick one — number keys 1–4 work too.';
  $('quiz-next').hidden = true;

  // distractors: unique answers of other cards in the deck
  const right = backText(c);
  const pool = [...new Set(d.cards.filter(x => x.id !== c.id).map(x => backText(x)).filter(x => x && x !== right))];
  shuffleInPlace(pool);
  const opts = [right, ...pool.slice(0, 3)];
  shuffleInPlace(opts);

  const qw = $('quiz-wrap');
  qw.classList.remove('deal'); void qw.offsetWidth;
  if (anim !== 'slide') qw.classList.add('deal');
  const list = $('quiz-list');
  list.innerHTML = opts.map((o, i) => `
    <button class="quiz-opt" style="--i:${i}" data-ans="${esc(o)}">
      <span class="opt-key">${i + 1}</span><span>${esc(o)}</span>
    </button>`).join('');
  list.querySelectorAll('.quiz-opt').forEach(b =>
    b.addEventListener('click', () => answerQuiz(b)));
  if (Q.answered) markQuizAnswered(c);  // restore state after re-render
}

function answerQuiz(btn) {
  const Q = state.quiz;
  if (Q.answered) return;
  Q.answered = true;
  const c = quizCard();
  const right = backText(c);
  const chosen = btn.dataset.ans;
  const ok = chosen === right;
  Q.answeredId = c.id;
  Q.answeredPick = chosen;
  if (ok) { Q.correct++; c.status = 'mastered'; }
  else { c.status = 'learning'; Q.missed.push(c.id); }
  saveStore();
  markQuizAnswered(c, true);
}

function markQuizAnswered(c, fresh) {
  const Q = state.quiz;
  const right = backText(c);
  const ok = Q.answeredPick === right;
  $('quiz-list').querySelectorAll('.quiz-opt').forEach(b => {
    if (b.dataset.ans === right) {
      b.classList.add('correct');
      b.insertAdjacentHTML('beforeend', CHECK_SVG);
      if (fresh && Q.answeredPick === right) sprinkleFrom(b);
    }
    else if (b.dataset.ans === Q.answeredPick) b.classList.add('wrong');
    else b.classList.add('dim');
    b.disabled = true;
  });
  $('quiz-msg').textContent = ok ? 'Correct.' : `Answer: ${right.slice(0, 90)}${right.length > 90 ? '…' : ''}`;
  $('quiz-score').textContent = `${Q.correct} correct`;
  $('quiz-next').hidden = false;
  $('quiz-next').textContent = Q.idx + 1 >= Q.order.length ? 'Results ›' : 'Next ›';
  renderLibrary(); renderMeta();
}

function showQuizResults() {
  const Q = state.quiz;
  const pct = Q.order.length ? Math.round(Q.correct / Q.order.length * 100) : 0;
  if (!Q.celebrated) { Q.celebrated = true; setTimeout(() => celebrateSet(pct), 140); }
  openModal(`
    <h3>Quiz results</h3>
    <p class="modal-sub">${esc(deck().title)} · ${Q.order.length} questions</p>
    <div class="result-grid">
      <div class="result-cell"><div class="rv">${pct}%</div><div class="rl">score</div></div>
      <div class="result-cell good"><div class="rv">${Q.correct}</div><div class="rl">correct</div></div>
      <div class="result-cell ${Q.missed.length ? 'bad' : ''}"><div class="rv">${Q.order.length - Q.correct}</div><div class="rl">missed</div></div>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" data-close>Done</button>
      ${Q.missed.length ? '<button class="btn" id="quiz-missed">Retry missed</button>' : ''}
      <button class="btn primary" id="quiz-restart">Restart quiz</button>
    </div>`);
  $('quiz-restart').addEventListener('click', () => {
    closeModal();
    state.quiz = { order: shuffleInPlace(studyCards(deck()).map(c => c.id)), idx: 0, correct: 0, answered: false, missed: [] };
    renderQuiz();
  });
  const retry = $('quiz-missed');
  if (retry) retry.addEventListener('click', () => {
    closeModal();
    state.quiz = { order: shuffleInPlace([...Q.missed]), idx: 0, correct: 0, answered: false, missed: [] };
    renderQuiz();
  });
}

/* ---------------- WRITE ---------------- */

function writeCard() {
  const d = deck();
  return d ? d.cards.find(c => c.id === state.write.order[state.write.idx]) || null : null;
}

function renderWrite(anim) {
  const d = deck(); if (!d) return;
  const W = state.write;

  const writeEmptyEl = $('write-empty');
  if (!W.order.length) {
    $('write-count').textContent = '';
    $('write-progress').style.width = '0%';
    $('write-score').textContent = '';
    $('write-wrap').style.display = 'none';
    writeEmptyEl.hidden = false;
    writeEmptyEl.textContent = state.starredOnly && d.cards.length
      ? `No starred cards — ${emptyStudySet('No starred cards')}`
      : `Nothing to write — ${emptyStudySet('')}`;
    $('write-form').style.visibility = 'hidden';
    $('write-feedback').textContent = '';
    $('write-skip').parentElement.style.visibility = 'hidden';
    return;
  }
  $('write-wrap').style.display = '';
  writeEmptyEl.hidden = true;
  $('write-form').style.visibility = '';

  if (W.idx >= W.order.length) {  // session complete — terminal state
    if (!W.done) { W.done = true; showWriteResults(); }
    $('write-count').textContent = `${W.order.length} / ${W.order.length}`;
    $('write-progress').style.width = '100%';
    $('write-score').textContent = `${W.correct} right`;
    $('write-corner').textContent = 'DONE';
    $('write-front-label').textContent = 'Session complete';
    $('write-front').textContent = 'Done.';
    const doneInput = $('write-input');
    doneInput.value = ''; doneInput.disabled = true; doneInput.placeholder = 'session complete';
    $('write-check').textContent = 'Done'; $('write-check').disabled = true;
    $('write-feedback').className = 'write-feedback';
    $('write-feedback').textContent = `${W.correct} of ${W.order.length} right`;
    $('write-skip').parentElement.style.visibility = 'hidden';
    return;
  }
  $('write-check').disabled = false;
  $('write-input').placeholder = 'type the answer…';
  $('write-skip').parentElement.style.visibility = '';
  const c = writeCard(); if (!c) return;

  W.checked = W.checkedId === c.id;
  $('write-count').textContent = `${W.idx + 1} / ${W.order.length}`;
  $('write-progress').style.width = `${((W.idx + 1) / W.order.length * 100)}%`;
  $('write-score').textContent = `${W.correct} right`;
  $('write-corner').textContent = `W${String(W.idx + 1).padStart(2, '0')}`;
  $('write-front-label').textContent = 'Write the answer';
  $('write-front').textContent = frontText(c);
  $('write-feedback').textContent = '';
  $('write-feedback').className = 'write-feedback';
  const input = $('write-input');
  input.value = '';
  input.disabled = false;
  $('write-check').textContent = 'Check';
  if (W.checked) restoreWriteChecked();  // restore state after re-render
  const ww = $('write-wrap');
  ww.classList.remove('deal'); void ww.offsetWidth;
  if (anim !== 'slide') ww.classList.add('deal');
  setTimeout(() => { if (!W.checked) input.focus(); }, 30);
}

function restoreWriteChecked() {
  const W = state.write;
  const fb = $('write-feedback');
  fb.className = W.fbClass || 'write-feedback';
  fb.innerHTML = W.fbHtml || '';
  const input = $('write-input');
  input.value = W.guessVal || '';
  input.disabled = true;
  $('write-check').textContent = 'Next ›';
}

function markWriteChecked(c) {
  const W = state.write;
  W.checked = true;
  W.checkedId = c.id;
  W.fbClass = $('write-feedback').className;
  W.fbHtml = $('write-feedback').innerHTML;
  W.guessVal = $('write-input').value;
  $('write-input').disabled = true;
  $('write-check').textContent = 'Next ›';
}

function checkWrite(reveal = false) {
  const W = state.write;
  const c = writeCard(); if (!c) return;
  if (W.checked) {  // second press = advance
    slideCard($('write-wrap'), 1, () => { W.idx++; renderWrite('slide'); });
    return;
  }
  const expected = backText(c);
  const input = $('write-input');
  const fb = $('write-feedback');

  if (reveal) {
    fb.className = 'write-feedback no';
    fb.innerHTML = `The answer: <span class="expected">${esc(expected)}</span>`;
    c.status = 'learning';
    if (!W.missed.includes(c.id)) W.missed.push(c.id);
    markWriteChecked(c);
    saveStore(); renderLibrary(); renderMeta();
    return;
  }

  const guess = input.value;
  if (!norm(guess)) { input.focus(); return; }

  const d1 = levenshtein(norm(guess), norm(expected));
  const closeEnough = d1 === 0;
  const almost = !closeEnough && norm(expected).length > 3 && d1 <= Math.max(1, Math.floor(norm(expected).length * 0.15));

  if (closeEnough) {
    fb.className = 'write-feedback ok';
    fb.innerHTML = CHECK_SVG + ' Correct.';
    input.classList.remove('ok-flash'); void input.offsetWidth; input.classList.add('ok-flash');
    sprinkleFrom(input);
    c.status = 'mastered';
    W.correct++;
  } else {
    fb.className = 'write-feedback no';
    fb.innerHTML = almost
      ? `Close — exact answer: <span class="expected">${esc(expected)}</span>`
      : `Answer: <span class="expected">${esc(expected)}</span>`;
    c.status = 'learning';
    if (almost) W.correct++;  // count near-misses as known-ish
    else if (!W.missed.includes(c.id)) W.missed.push(c.id);
  }
  markWriteChecked(c);
  $('write-score').textContent = `${W.correct} right`;
  saveStore(); renderLibrary(); renderMeta();
}

function showWriteResults() {
  const W = state.write;
  const pct = W.order.length ? Math.round(W.correct / W.order.length * 100) : 0;
  if (!W.celebrated) { W.celebrated = true; setTimeout(() => celebrateSet(pct), 140); }
  openModal(`
    <h3>Writing results</h3>
    <p class="modal-sub">${esc(deck().title)} · ${W.order.length} cards</p>
    <div class="result-grid">
      <div class="result-cell"><div class="rv">${pct}%</div><div class="rl">accuracy</div></div>
      <div class="result-cell good"><div class="rv">${W.correct}</div><div class="rl">right</div></div>
      <div class="result-cell ${W.missed.length ? 'bad' : ''}"><div class="rv">${W.missed.length}</div><div class="rl">missed</div></div>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" data-close>Done</button>
      ${W.missed.length ? '<button class="btn" id="write-missed">Retry missed</button>' : ''}
      <button class="btn primary" id="write-restart">Go again</button>
    </div>`);
  $('write-restart').addEventListener('click', () => {
    closeModal();
    state.write = { order: shuffleInPlace(studyCards(deck()).map(c => c.id)), idx: 0, correct: 0, checked: false, missed: [] };
    renderWrite();
  });
  const retry = $('write-missed');
  if (retry) retry.addEventListener('click', () => {
    closeModal();
    state.write = { order: shuffleInPlace([...W.missed]), idx: 0, correct: 0, checked: false, missed: [] };
    renderWrite();
  });
}

/* ---------------- CARDS EDITOR ---------------- */

function renderEditor() {
  const d = deck(); if (!d) return;
  const table = $('card-table');
  const q = norm(state.search);
  const starOnly = $('star-all-view')?.classList.contains('on');
  const rows = d.cards
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => (!starOnly || c.starred)
      && (!q || norm(c.q).includes(q) || norm(c.a).includes(q) || norm(c.ex).includes(q)));

  if (!rows.length) {
    table.innerHTML = `<div class="card-row" style="grid-template-columns:1fr"><span class="cell def">${q ? 'No cards match that filter.' : 'No cards yet — add one below.'}</span></div>`;
  } else {
    table.innerHTML = rows.map(({ c, i }) => `
      <div class="card-row" data-id="${c.id}" draggable="true">
        <span class="drag-handle" title="Drag to reorder">⠿</span>
        <span class="row-num">${String(i + 1).padStart(2, '0')}</span>
        <span class="cell"><b>${esc(c.q)}</b>${c.status !== 'new' ? `<span class="status-chip ${c.status}">${c.status}</span>` : ''}</span>
        <span class="cell def">${esc(c.a)}${c.ex ? `<span style="color:var(--ink-3)"> · ${esc(c.ex)}</span>` : ''}</span>
        <span class="row-actions">
          <button class="mini-btn star ${c.starred ? 'starred' : ''}" data-act="star" title="Star">
            <svg viewBox="0 0 24 24" fill="${c.starred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7-6.2-3.7-6.2 3.7 1.6-7L2 9.2l7.1-.6z"/></svg>
          </button>
          <button class="mini-btn" data-act="edit" title="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
          </button>
          <button class="mini-btn" data-act="del" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2m1 0-1 16H8L7 6"/></svg>
          </button>
        </span>
      </div>`).join('');
  }
  wireEditorRows(table);
  wireDrag(table);
}

function wireEditorRows(table) {
  table.querySelectorAll('.card-row[data-id]').forEach(row => {
    const id = row.dataset.id;
    row.querySelectorAll('.mini-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const c = deck().cards.find(x => x.id === id);
        if (!c) return;
        const act = btn.dataset.act;
        if (act === 'star') { c.starred = !c.starred; saveStore(); renderEditor(); renderLibrary(); renderMeta(); }
        else if (act === 'del') { deck().cards = deck().cards.filter(x => x.id !== id); saveStore(); resetSessions(); renderEditor(); renderLibrary(); renderMeta(); toast('Card deleted'); }
        else if (act === 'edit') editRow(row, c);
      });
    });
  });
}

function editRow(row, c) {
  row.classList.add('editing');
  row.innerHTML = `
    <span class="row-num"></span>
    <input class="cell-input" data-f="q" value="${esc(c.q)}" placeholder="front">
    <input class="cell-input" data-f="a" value="${esc(c.a)}" placeholder="back">
    <input class="cell-input" data-f="ex" value="${esc(c.ex || '')}" placeholder="note">
    <span class="row-actions" style="opacity:1">
      <button class="btn small primary" data-act="save">Save</button>
      <button class="btn small ghost" data-act="cancel">×</button>
    </span>`;
  row.querySelector('[data-act="save"]').addEventListener('click', () => {
    c.q = row.querySelector('[data-f="q"]').value.trim() || c.q;
    c.a = row.querySelector('[data-f="a"]').value.trim() || c.a;
    c.ex = row.querySelector('[data-f="ex"]').value.trim();
    saveStore(); resetSessions(); renderAll();
    toast('Card saved');
  });
  row.querySelector('[data-act="cancel"]').addEventListener('click', renderEditor);
}

function wireDrag(table) {
  let dragId = null;
  table.querySelectorAll('.card-row[data-id]').forEach(row => {
    row.addEventListener('dragstart', e => {
      dragId = row.dataset.id;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    row.addEventListener('drop', e => {
      e.preventDefault();
      if (!dragId || dragId === row.dataset.id) return;
      const d = deck();
      const from = d.cards.findIndex(c => c.id === dragId);
      const to = d.cards.findIndex(c => c.id === row.dataset.id);
      if (from < 0 || to < 0) return;
      const [moved] = d.cards.splice(from, 1);
      d.cards.splice(to, 0, moved);
      saveStore(); resetSessions(); renderEditor();
    });
  });
}

function renderMeta() {  // refresh header bits without mode re-render
  const d = deck(); if (!d) return;
  const s = deckStats(d);
  els.deckMeta.innerHTML =
    `<span><b>${s.total}</b> card${s.total === 1 ? '' : 's'}</span>` +
    `<span><b>${s.mastered}</b> mastered</span>` +
    `<span>${relTime(d.lastStudiedAt)}</span>` +
    (d.flipped ? `<span>sides swapped</span>` : '');
  els.cardsTabCount.textContent = `(${s.total})`;
}

/* ---------------- import / export / share ---------------- */

function parsePasted(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const out = [];
  const headerRe = /^(q|term|front|question|word|prompt)\s*[:,;\t]/i;
  for (const [li, line] of lines.entries()) {
    if (li === 0 && headerRe.test(line)) continue;  // skip "q,a,note" style headers
    let note = '';
    let main = line;
    const pipe = line.indexOf('|');
    if (pipe > -1) { main = line.slice(0, pipe).trim(); note = line.slice(pipe + 1).trim(); }
    let q = '', a = '';
    for (const sep of ['\t', ' : ', ' — ', ' – ', ':', ',', ';', ' = ']) {
      const i = main.indexOf(sep);
      if (i > 0) { q = main.slice(0, i).trim(); a = main.slice(i + sep.length).trim(); break; }
    }
    if (q && a) out.push({ q: diacritics(q), a: diacritics(a), ex: diacritics(note) });
  }
  return out;
}

function parseCsvRows(text, delim = ',') {
  const rows = [];
  let cur = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { cur.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cur.push(field); field = '';
      if (cur.some(x => x !== '')) rows.push(cur);
      cur = [];
    } else field += ch;
  }
  cur.push(field);
  if (cur.some(x => x !== '')) rows.push(cur);
  return rows;
}

function csvRowsToCards(rows) {
  if (!rows.length) return [];
  const head = rows[0].map(h => norm(h));
  const qKeys = ['q', 'question', 'term', 'front', 'prompt'];
  const aKeys = ['a', 'answer', 'definition', 'def', 'back'];
  const eKeys = ['ex', 'example', 'note', 'notes'];
  let qi = 0, ai = 1, ei = 2, start = 0;
  if (qKeys.includes(head[0]) || aKeys.includes(head[1])) {
    const fq = head.findIndex(h => qKeys.includes(h));
    const fa = head.findIndex(h => aKeys.includes(h));
    if (fq > -1) qi = fq;
    if (fa > -1) ai = fa;
    ei = head.findIndex(h => eKeys.includes(h));
    start = 1;
  }
  return rows.slice(start)
    .map(r => ({ q: r[qi] || '', a: r[ai] || '', ex: ei > -1 ? (r[ei] || '') : '' }))
    .filter(c => c.q && c.a);
}

function parseJsonCards(obj) {
  const arr = obj.cards || obj;
  if (!Array.isArray(arr)) return null;
  return arr.map(c => {
    if (Array.isArray(c)) return { q: c[0] || '', a: c[1] || '', ex: c[2] || '' };
    return {
      q: c.q ?? c.question ?? c.term ?? c.front ?? '',
      a: c.a ?? c.definition ?? c.answer ?? c.back ?? '',
      ex: c.ex ?? c.example ?? c.note ?? '',
    };
  }).filter(c => c.q && c.a);
}

function openImportModal() {
  openModal(`
    <h3>Import cards</h3>
    <p class="modal-sub">Paste one card per line, or drop in a file. Separators auto-detect: <code>term : answer</code>, <code>term,answer</code>, <code>term[TAB]answer</code>. An optional note follows a <code>|</code>.</p>
    <label class="field-label" for="imp-title">Deck title</label>
    <input class="field-input" id="imp-title" placeholder="e.g. Spanish unit 3" maxlength="140">
    <label class="field-label" for="imp-text">Cards</label>
    <textarea class="field-textarea" id="imp-text" rows="8" placeholder="Paris : capital of France&#10;mitochondria,powerhouse of the cell&#10;quixotic | idealistic, unrealistic"></textarea>
    <div class="parse-preview" id="imp-preview">paste cards to preview the count</div>
    <div class="modal-actions" style="justify-content:space-between">
      <button class="btn ghost" id="imp-file">Choose file (.json / .csv / .txt)</button>
      <span style="display:flex;gap:10px">
        <button class="btn ghost" data-close>Cancel</button>
        <button class="btn primary" id="imp-go">Import into new deck</button>
      </span>
    </div>`, { wide: true });

  const text = $('imp-text'), preview = $('imp-preview'), title = $('imp-title');
  const updatePreview = () => {
    const n = parsePasted(text.value).length;
    preview.textContent = n ? `${n} valid card${n === 1 ? '' : 's'} detected` : 'no valid cards yet — each line needs a term and an answer';
  };
  text.addEventListener('input', updatePreview);

  $('imp-file').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,.csv,.tsv,.txt';
    inp.onchange = () => {
      const f = inp.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        const body = String(r.result || '');
        let cards = null, t = '';
        if (f.name.endsWith('.json') || body.trim().startsWith('{') || body.trim().startsWith('[')) {
          try {
            const obj = JSON.parse(body);
            cards = parseJsonCards(obj);
            t = obj.title || obj.t || f.name.replace(/\.[^.]+$/, '');
          } catch { toast('That file isn’t valid JSON.'); return; }
        } else if (/\.(csv|tsv)$/i.test(f.name)) {
          cards = csvRowsToCards(parseCsvRows(body, f.name.toLowerCase().endsWith('.tsv') ? '\t' : ','));
          t = f.name.replace(/\.[^.]+$/, '');
        } else {
          cards = parsePasted(body);
          t = f.name.replace(/\.[^.]+$/, '');
        }
        if (!cards || !cards.length) { toast('No cards found in that file.'); return; }
        closeModal();
        const d = createDeck(t || 'Imported deck', cards.map(c => newCard(c.q, c.a, c.ex)));
        saveStore(); selectDeck(d.id);
        toast(`Imported ${d.cards.length} cards`);
      };
      r.readAsText(f);
    };
    inp.click();
  });

  $('imp-go').addEventListener('click', () => {
    const cards = parsePasted(text.value);
    if (!cards.length) { preview.textContent = 'Nothing to import — write at least one term : answer line.'; return; }
    const d = createDeck(title.value.trim() || 'Untitled deck', cards.map(c => newCard(c.q, c.a, c.ex)));
    closeModal();
    saveStore(); selectDeck(d.id);
    toast(`Created “${d.title}” — ${d.cards.length} cards`);
  });
}

function openShareModal() {
  const d = deck(); if (!d || !d.cards.length) { toast('Add some cards first.'); return; }
  const encoded = encodeDeckV2(d.title, d.cards);
  const url = `${location.protocol}//${location.host}${location.pathname}?d=${encoded}`;
  const len = url.length;
  const over = len > URL_SAFE_LIMIT;
  openModal(`
    <h3>Share this deck</h3>
    <p class="modal-sub">The whole deck rides inside the link — anyone who opens it gets a copy. Nothing is uploaded anywhere.</p>
    ${len > URL_HARD_LIMIT
      ? `<p class="modal-sub" style="color:var(--red)">This deck is too big for a link (${len.toLocaleString()} characters). Export it as a file instead — Deck ▸ Export.</p>`
      : `<div class="link-out"><input id="share-out" readonly value="${esc(url)}"><button class="btn primary" id="share-copy">Copy</button></div>
         <div class="meter">
           <div class="meter-row"><span>${len.toLocaleString()} characters</span><span>${over ? 'long link — may not paste cleanly everywhere' : `${Math.max(0, Math.round(100 - len / URL_SAFE_LIMIT * 100))}% headroom`}</span></div>
           <div class="meter-track"><i class="${over ? 'warn' : ''}" style="width:${Math.min(100, len / URL_SAFE_LIMIT * 100)}%"></i></div>
         </div>`}
    <div class="modal-actions"><button class="btn ghost" data-close>Close</button></div>`);
  const copy = $('share-copy');
  if (copy) copy.addEventListener('click', () => {
    const out = $('share-out');
    out.select();
    navigator.clipboard?.writeText(out.value).then(() => toast('Link copied')).catch(() => {
      document.execCommand('copy'); toast('Link copied');
    });
  });
}

function download(name, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ---------------- library backup ---------------- */

function exportLibrary() {
  const decks = Object.values(state.decks).map(d => ({
    title: d.title,
    flipped: !!d.flipped,
    lastStudiedAt: d.lastStudiedAt || 0,
    cards: d.cards.map(c => ({ q: c.q, a: c.a, ex: c.ex, starred: !!c.starred, status: c.status || 'new' })),
  }));
  const stamp = new Date().toISOString().slice(0, 10);
  download(`flashcards_library_${stamp}.json`,
    JSON.stringify({ app: 'flashcards', kind: 'library-backup', version: 1, exportedAt: new Date().toISOString(), decks }, null, 2),
    'application/json');
  toast(`Backed up ${decks.length} decks`);
  closeModal();
}

function openClearLibrary() {
  const n = Object.keys(state.decks).length;
  if (!n) { toast('The library is already empty'); return; }
  openModal(`
    <h3>Clear the library?</h3>
    <p class="modal-sub">${n === 1 ? 'The deck in this library' : `All ${n} decks in this library`} will be removed from this browser. Decks you've already sent as links keep working for whoever has them.</p>
    <div class="modal-actions">
      <button class="btn ghost" id="cl-backup">Backup first</button>
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn danger" id="cl-ok">Clear all</button>
    </div>`);
  $('cl-backup').addEventListener('click', exportLibrary);  // downloads + closes the dialog
  $('cl-ok').addEventListener('click', () => {
    state.decks = {};
    state.currentId = null;
    try { localStorage.removeItem(LAST_KEY); } catch {}
    saveStore(); resetSessions(); renderAll();
    closeModal();
    toast('Library cleared');
  });
}

function importLibrary(obj) {
  const rows = obj.decks;
  let added = 0, skipped = 0;
  for (const row of rows) {
    if (!row || !Array.isArray(row.cards)) { skipped++; continue; }
    const cards = row.cards.map(c => ({
      q: diacritics(c.q || ''), a: diacritics(c.a || ''), ex: diacritics(c.ex || c.note || ''),
      starred: !!c.starred, status: c.status,
    })).filter(c => c.q && c.a);
    if (!cards.length) { skipped++; continue; }
    const fp = deckFingerprint(row.title || 'Deck', cards);
    if (Object.values(state.decks).some(d =>
      deckFingerprint(d.title, d.cards.map(c => ({ q: c.q, a: c.a }))) === fp)) { skipped++; continue; }
    const d = createDeck(row.title || 'Deck', cards.map(c => {
      const nc = newCard(c.q, c.a, c.ex);
      nc.starred = c.starred;
      if (['new', 'learning', 'mastered'].includes(c.status)) nc.status = c.status;
      return nc;
    }));
    d.flipped = !!row.flipped;
    if (row.lastStudiedAt > 0) d.lastStudiedAt = row.lastStudiedAt;
    added++;
  }
  saveStore(); renderLibrary(); renderMeta();
  closeModal();
  toast(`Restored ${added} deck${added === 1 ? '' : 's'}${skipped ? ` · skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : ''}`, 3200);
  if (added && !state.currentId) selectDeck(Object.keys(state.decks)[0]);
}

function openBackupModal() {
  const n = Object.keys(state.decks).length;
  openModal(`
    <h3>Backup &amp; restore</h3>
    <p class="modal-sub">${n} deck${n === 1 ? '' : 's'} in this browser → one <code>.json</code> file (stars and progress included). Restoring merges into the current library; decks already here are skipped, so it also works to combine libraries from different browsers.</p>
    <div class="modal-actions" style="justify-content:space-between">
      <button class="btn ghost" id="bk-restore">Restore from file…</button>
      <span style="display:flex;gap:10px">
        <button class="btn ghost" data-close>Cancel</button>
        <button class="btn primary" id="bk-export">Download backup</button>
      </span>
    </div>`);
  $('bk-export').addEventListener('click', exportLibrary);
  $('bk-restore').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json';
    inp.onchange = () => {
      const f = inp.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const obj = JSON.parse(String(r.result || ''));
          if (Array.isArray(obj.decks)) { importLibrary(obj); return; }
          // fall back: a single-deck export file
          const cards = parseJsonCards(obj);
          if (!cards || !cards.length) { toast('No decks found in that file.'); return; }
          closeModal();
          const d = createDeck(obj.title || obj.t || 'Restored deck', cards.map(c => newCard(c.q, c.a, c.ex)));
          saveStore(); selectDeck(d.id);
          toast(`Restored “${d.title}”`);
        } catch { toast('That file isn’t valid JSON.'); }
      };
      r.readAsText(f);
    };
    inp.click();
  });
}

function exportJson(d = deck()) {
  if (!d) return;
  download(`flashcards_${d.title.replace(/[^\w]+/g, '_')}.json`,
    JSON.stringify({ title: d.title, version: '3.0', cards: d.cards.map(c => ({ q: c.q, a: c.a, note: c.ex })) }, null, 2),
    'application/json');
}

function exportCsv() {
  const d = deck(); if (!d) return;
  const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = ['term,answer,note', ...d.cards.map(c => `${q(c.q)},${q(c.a)},${q(c.ex)}`)];
  download(`flashcards_${d.title.replace(/[^\w]+/g, '_')}.csv`, lines.join('\n'), 'text/csv');
}

function copyAsText() {
  const d = deck(); if (!d) return;
  const body = d.cards.map(c => `${c.q} : ${c.a}${c.ex ? ` | ${c.ex}` : ''}`).join('\n');
  navigator.clipboard?.writeText(`${d.title}\n\n${body}`)
    .then(() => toast('Deck copied as text'))
    .catch(() => toast('Copy failed — export instead'));
}

function printDeck() {
  const d = deck(); if (!d) return;
  els.printSheet.innerHTML = `
    <h1>${esc(d.title)}</h1>
    <p class="pmeta">${d.cards.length} cards · printed from flashcards · ${new Date().toLocaleDateString()}</p>
    <table>
      <thead><tr><th style="width:6%">#</th><th style="width:47%">${d.flipped ? 'answer' : 'term'}</th><th>${d.flipped ? 'term' : 'answer'} · note</th></tr></thead>
      <tbody>${d.cards.map((c, i) => `
        <tr><td>${i + 1}</td><td><b>${esc(d.flipped ? c.a : c.q)}</b></td><td>${esc(d.flipped ? c.q : c.a)}${c.ex ? `<br><i>${esc(c.ex)}</i>` : ''}</td></tr>`).join('')}
      </tbody>
    </table>`;
  window.print();
}

/* ---------------- theme / fullscreen / menu ---------------- */

function applyTheme(dark) {
  if (dark) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch {}
}

function toggleFullscreen() {
  const el = state.mode === 'learn' ? $('learn-wrap') : $('card-wrap');
  try {
    if (!document.fullscreenElement) (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    else (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } catch { toast('Fullscreen blocked here — press F11 instead'); }
}

function wireMenu() {
  const btn = $('deck-menu-btn'), menu = $('deck-menu');
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', e => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) menu.hidden = true;
    const rm = $('row-menu');
    if (rm && !rm.hidden && !rm.contains(e.target) && !e.target.closest('.dr-kebab')) { rm.hidden = true; rowMenuFor = null; }
  });
  // row-menu is position:fixed — scrolling would detach it from its row, so close instead
  window.addEventListener('scroll', () => {
    const rm = $('row-menu');
    if (rm && !rm.hidden) { rm.hidden = true; rowMenuFor = null; }
  }, true);
  $('menu-rename').addEventListener('click', () => {
    menu.hidden = true;
    promptModal('Rename deck', 'Deck title', deck().title, v => {
      deck().title = v; saveStore(); renderAll();
    });
  });
  $('menu-reverse').addEventListener('click', () => {
    menu.hidden = true; deck().flipped = !deck().flipped; saveStore(); resetSessions(); renderAll();
    toast(deck().flipped ? 'Showing answers first' : 'Showing terms first');
  });
  $('menu-duplicate').addEventListener('click', () => {
    menu.hidden = true;
    const d = deck();
    const copy = createDeck(`${d.title} (copy)`, d.cards.map(c => newCard(c.q, c.a, c.ex)));
    saveStore(); selectDeck(copy.id);
    toast('Deck duplicated');
  });
  $('menu-share-text').addEventListener('click', () => { menu.hidden = true; copyAsText(); });
  $('menu-export-json').addEventListener('click', () => { menu.hidden = true; exportJson(); });
  $('menu-export-csv').addEventListener('click', () => { menu.hidden = true; exportCsv(); });
  $('menu-print').addEventListener('click', () => { menu.hidden = true; printDeck(); });
  $('menu-delete').addEventListener('click', () => {
    menu.hidden = true;
    const d = deck();
    confirmModal('Delete this deck?', `“${esc(d.title)}” and its ${d.cards.length} cards will be removed from this browser. Anyone with the share link keeps their copy.`, 'Delete deck', () => {
      delete state.decks[d.id];
      saveStore();
      const remaining = Object.keys(state.decks)[0];
      if (remaining) selectDeck(remaining);
      else { state.currentId = null; localStorage.removeItem(LAST_KEY); renderAll(); }
      toast('Deck deleted');
    });
  });
}

/* ---------------- shortcuts modal ---------------- */

function openShortcuts() {
  openModal(`
    <h3>Keyboard map</h3>
    <p class="modal-sub">Works from anywhere except inside a text field.</p>
    <div class="shortcut-list">
      <div class="sk"><span>flip card</span><span class="kbd">space</span></div>
      <div class="sk"><span>next / previous</span><span class="kbd">← →</span></div>
      <div class="sk"><span>shuffle deck</span><span class="kbd">S</span></div>
      <div class="sk"><span>star card</span><span class="kbd">B</span></div>
      <div class="sk"><span>swap card sides</span><span class="kbd">R</span></div>
      <div class="sk"><span>fullscreen card</span><span class="kbd">F</span></div>
      <div class="sk"><span>starred-only filter</span><span class="kbd">*</span></div>
      <div class="sk"><span>learn: knew it / again</span><span class="kbd">K / L</span></div>
      <div class="sk"><span>quiz: answer 1–4</span><span class="kbd">1–4</span></div>
      <div class="sk"><span>theme</span><span class="kbd">T</span></div>
      <div class="sk"><span>close dialog</span><span class="kbd">esc</span></div>
    </div>
    <div class="modal-actions"><button class="btn primary" data-close>Got it</button></div>`);
}

/* ---------------- events ---------------- */

function wireEvents() {
  // top bar
  $('theme-btn').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme !== 'dark');
  });
  $('shortcuts-btn').addEventListener('click', openShortcuts);
  $('motion-btn').addEventListener('click', () => {
    applyMotionPref(motionPref === 'auto' ? 'on' : motionPref === 'on' ? 'off' : 'auto');
  });

  // sidebar / empty
  $('new-deck-btn').addEventListener('click', openImportModal);
  $('import-btn').addEventListener('click', openImportModal);
  $('backup-btn').addEventListener('click', openBackupModal);
  $('library-search').addEventListener('input', e => { state.libSearch = e.target.value; renderLibrary(); });
  $('clear-lib-btn').addEventListener('click', openClearLibrary);
  $('empty-new').addEventListener('click', openImportModal);
  $('empty-import').addEventListener('click', openImportModal);
  $('empty-keys').addEventListener('click', openShortcuts);

  // header actions
  $('share-btn').addEventListener('click', openShareModal);
  $('starred-filter').addEventListener('click', () => {
    state.starredOnly = !state.starredOnly;
    resetSessions(); renderAll();
    if (state.starredOnly) toast('Studying starred cards only');
  });
  wireMenu();

  // mode tabs
  $('mode-tabs').addEventListener('click', e => {
    const t = e.target.closest('.mode-tab');
    if (!t) return;
    state.mode = t.dataset.mode;
    renderAll();
  });

  // review stage
  $('card-wrap').addEventListener('click', e => {
    if (e.target.closest('.star-corner')) return;
    const wrap = $('card-wrap');
    state.review.flipped = !wrap.classList.contains('flipped');
    flipCardEl(wrap, state.review.flipped);
  });
  $('card-wrap').addEventListener('keydown', e => {
    // stopPropagation — the document-level keydown also flips, so without
    // this a Space on a focused wrap fires two flips and cancels itself out
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); $('card-wrap').click(); }
  });
  $('star-btn').addEventListener('click', e => {
    e.stopPropagation();
    const c = reviewCard(); if (!c) return;
    c.starred = !c.starred;
    saveStore(); renderReview(); renderLibrary(); renderMeta();
    // earning a star gets a springy twinkle; removing one stays quiet
    if (c.starred && !motionReduced()) {
      const s2 = $('star-btn').querySelector('svg');
      if (s2) s2.animate([
        { transform: 'scale(.55) rotate(-24deg)' },
        { transform: 'scale(1.25) rotate(8deg)', offset: .6 },
        { transform: 'scale(1) rotate(0)' },
      ], { duration: 360, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    }
  });
  $('flip-pill').addEventListener('click', () => $('card-wrap').click());
  $('prev-btn').addEventListener('click', () => {
    if (state.review.idx > 0) slideCard($('card-wrap'), -1, () => { state.review.idx--; renderReview('slide'); });
  });
  $('next-btn').addEventListener('click', () => {
    if (state.review.idx < state.review.order.length - 1) slideCard($('card-wrap'), 1, () => { state.review.idx++; renderReview('slide'); });
  });
  $('shuffle-pill').addEventListener('click', () => {
    const R = state.review;
    if (R.shuffled) {
      R.order = studyCards(deck()).map(c => c.id);
      R.shuffled = false;
    } else {
      R.order = shuffleInPlace(R.order.slice());
      R.shuffled = true;
    }
    R.idx = 0;
    renderReview();
  });
  $('sides-pill').addEventListener('click', () => {
    deck().flipped = !deck().flipped;
    const R = state.review;
    // on the Done card there's no position to preserve — restart the run
    if (R.idx >= R.order.length) R.idx = 0;
    saveStore(); renderReview(); renderMeta();
  });
  $('fs-pill').addEventListener('click', toggleFullscreen);

  // learn stage
  $('learn-wrap').addEventListener('click', () => flipCardEl($('learn-wrap')));
  $('learn-wrap').addEventListener('keydown', e => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); flipCardEl($('learn-wrap')); }
  });
  $('verdict-known').addEventListener('click', () => learnVerdict(true));
  $('verdict-learning').addEventListener('click', () => learnVerdict(false));

  // quiz stage
  $('quiz-next').addEventListener('click', () => {
    slideCard($('quiz-wrap'), 1, () => { state.quiz.idx++; renderQuiz('slide'); });
  });

  // write stage
  $('write-form').addEventListener('submit', e => { e.preventDefault(); checkWrite(false); });
  $('write-reveal').addEventListener('click', () => checkWrite(true));
  $('write-skip').addEventListener('click', () => {
    const W = state.write, c = writeCard();
    slideCard($('write-wrap'), 1, () => {
      if (c) {
        if (!W.missed.includes(c.id)) W.missed.push(c.id);
        c.status = 'learning';
        saveStore(); renderLibrary(); renderMeta();
      }
      W.idx++; renderWrite('slide');
    });
  });

  // editor stage
  $('card-search').addEventListener('input', e => { state.search = e.target.value; renderEditor(); });
  $('star-all-view').addEventListener('click', function () {
    this.classList.toggle('on');
    renderEditor();
  });
  $('reset-progress').addEventListener('click', () => {
    confirmModal('Reset progress?', 'Every card in this deck goes back to “new”. Stars stay.', 'Reset progress', () => {
      deck().cards.forEach(c => { c.status = 'new'; });
      saveStore(); resetSessions(); renderAll();
      toast('Progress reset');
    });
  });
  $('add-card-btn').addEventListener('click', () => {
    const f = $('add-front').value.trim(), b = $('add-back').value.trim(), n = $('add-note').value.trim();
    if (!f || !b) { toast('A card needs both a front and a back'); return; }
    deck().cards.push(newCard(diacritics(f), diacritics(b), diacritics(n)));
    $('add-front').value = ''; $('add-back').value = ''; $('add-note').value = '';
    $('add-front').focus();
    saveStore(); resetSessions(); renderEditor(); renderLibrary(); renderMeta();
  });

  window.addEventListener('resize', positionTabInk);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(positionTabInk);

  // global keys
  document.addEventListener('keydown', e => {
    if (!els.veil.hidden) {
      if (e.key === 'Escape') closeModal();
      return;
    }
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const k = e.key;
    if (k === 'Escape') {
      const rm = $('row-menu');
      const dm = $('deck-menu');
      if (rm && !rm.hidden) { rm.hidden = true; rowMenuFor = null; }
      else if (dm && !dm.hidden) { dm.hidden = true; $('deck-menu-btn').setAttribute('aria-expanded', 'false'); }
      return;
    }
    if (k === '?') { openShortcuts(); return; }
    if (k === 't' || k === 'T') { applyTheme(document.documentElement.dataset.theme !== 'dark'); return; }
    if (k === '*') { $('starred-filter').click(); return; }
    if (!deck() || els.deckView.hidden) return;

    if (state.mode === 'review') {
      if (k === 'ArrowRight') { $('next-btn').click(); }
      else if (k === 'ArrowLeft') { $('prev-btn').click(); }
      else if (k === ' ' || k === 'ArrowUp' || k === 'ArrowDown') { e.preventDefault(); $('card-wrap').click(); }
      else if (k === 's' || k === 'S') { $('shuffle-pill').click(); }
      else if (k === 'b' || k === 'B') { $('star-btn').click(); }
      else if (k === 'r' || k === 'R') { $('sides-pill').click(); }
      else if (k === 'f' || k === 'F') { toggleFullscreen(); }
    } else if (state.mode === 'learn') {
      if (k === ' ' || k === 'Enter') { e.preventDefault(); flipCardEl($('learn-wrap')); }
      else if (k === 'k' || k === 'K') learnVerdict(true);
      else if (k === 'l' || k === 'L') learnVerdict(false);
      else if (k === 'f' || k === 'F') toggleFullscreen();
    } else if (state.mode === 'quiz') {
      if (['1', '2', '3', '4'].includes(k)) {
        const opts = $('quiz-list').querySelectorAll('.quiz-opt');
        const i = +k - 1;
        if (opts[i]) opts[i].click();
      } else if ((k === 'Enter' || k === 'n' || k === 'N' || k === 'ArrowRight') && state.quiz.answered) {
        $('quiz-next').click();
      }
    } else if (state.mode === 'write') {
      if ((k === 'Enter') && state.write.checked) { /* form submit handles */ }
      else if (k === 'ArrowRight' && state.write.checked) { $('write-skip').click(); }
    }
  });
}

/* ---------------- boot ---------------- */

function boot() {
  loadStore();

  // theme
  const stored = (() => { try { return localStorage.getItem(THEME_KEY) || localStorage.getItem('theme'); } catch { return null; } })();
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(stored ? stored === 'dark' : prefersDark);
  applyMotionPref(motionPref);
  if (osReduceMQ.addEventListener) osReduceMQ.addEventListener('change', () => applyMotionPref(motionPref));

  // migrate: old single-file app stored decks as 'flashcard_deck_*'.
  // Each key is migrated once — deleting the imported deck must not resurrect it.
  const migrated = (() => { try { return new Set(JSON.parse(localStorage.getItem('cardfile.migratedKeys') || '[]')); } catch { return new Set(); } })();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('flashcard_deck_') || migrated.has(key)) continue;
    migrated.add(key);
    // one corrupt value must not abort the rest of the library
    try {
      const obj = JSON.parse(localStorage.getItem(key));
      if (obj && Array.isArray(obj.cards)) importSharedDeckSilent(obj.title || 'Saved deck', obj.cards.map(c =>
        ({ q: c.question ?? c.q, a: c.definition ?? c.a, ex: c.example ?? c.ex })));
    } catch {}
  }
  try { localStorage.setItem('cardfile.migratedKeys', JSON.stringify([...migrated])); } catch {}

  // one-time cleanup: decks saved while the diacritics guard skipped
  // mixed strings can hold literal ^ _ ` ´ shorthand — re-run the
  // transform once over every stored card, then mark it done so cards
  // written later (which may legitimately contain a_b or e^2) are
  // never rewritten.
  let diacriticsCleaned = false;
  try { diacriticsCleaned = localStorage.getItem('cardfile.diacriticsCleaned') === '1'; } catch {}
  if (!diacriticsCleaned) {
    let retouched = false;
    for (const d of Object.values(state.decks)) {
      for (const c of d.cards) {
        const nq = diacritics(c.q), na = diacritics(c.a), nx = diacritics(c.ex);
        if (nq !== c.q || na !== c.a || nx !== c.ex) { c.q = nq; c.a = na; c.ex = nx; retouched = true; }
      }
    }
    if (retouched) saveStore();
    try { localStorage.setItem('cardfile.diacriticsCleaned', '1'); } catch {}
  }

  function importSharedDeckSilent(title, raw) {
    const clean = raw.filter(c => c.q && c.a)
      .map(c => ({ q: diacritics(c.q), a: diacritics(c.a), ex: diacritics(c.ex || '') }));
    if (!clean.length) return;
    const fp = deckFingerprint(title, clean);
    if (Object.values(state.decks).some(d => deckFingerprint(d.title, d.cards.map(c => ({ q: c.q, a: c.a }))) === fp)) return;
    const d = createDeck(title, clean.map(c => newCard(c.q, c.a, c.ex)));
    saveStore();
  }

  wireEvents();

  const hadUrl = parseUrlDeck();
  if (!hadUrl) {
    const last = localStorage.getItem(LAST_KEY);
    if (last && state.decks[last]) selectDeck(last);
    else if (Object.keys(state.decks).length) selectDeck(Object.keys(state.decks)[0]);
    else renderAll();  // empty library → welcome page
  } else {
    // parseUrlDeck already selected the imported deck when successful
    if (!state.currentId && Object.keys(state.decks).length) selectDeck(Object.keys(state.decks)[0]);
    else renderAll();
  }
}

document.addEventListener('DOMContentLoaded', boot);
