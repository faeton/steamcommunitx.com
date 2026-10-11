// Home page "Recently checked" feed: SSE (polling fallback), drip-in with a
// split-flap animation, catch/release scrolling, and a nickname filter.
// All nickname text goes through DOM text nodes, never innerHTML. Optional
// browser APIs (Element.animate, getAnimations) are feature-checked because
// the Dota in-game browser runs an older Chromium.
import {
  t, ago, pickLang, avatarUrl, splitTerms, matchesTerms, highlightRanges,
  timeBlock, dripDelay, isNewer, diffEntries, idsToRemove, isStale, insertIndex, HOUR_MS
} from './feed-shared.js';

const ROW = 56;
const IDLE_MS = 8000;
const LEAVE_MS = 1500;
const HOVER_MAX_MS = 30000; // a cursor parked on the list does not freeze it forever
const RELEASE_FAILSAFE_MS = 1000; // go live even if the smooth scroll never reports reaching the top
const BURST = 3;
const MAX_DRIP = 60;
const MAX_ROWS = 200;
const POLL_MS = 30000;
const FLAP_TICK_MS = 45;
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZАБВГДЕЖЗИКЛМНОПРСТУ0123456789#@*';

const lang = pickLang(navigator.language);
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const canHover = matchMedia('(hover: hover)').matches;
const $ = id => document.getElementById(id);
const section = $('feed-section');
const box = $('feed');
const list = $('feed-list');
const pill = $('feed-pill');
const pillText = $('feed-pill-text');
const bar = $('feed-bar');
const qInput = $('feed-q');
const hitsEl = $('feed-hits');
const countEl = $('feed-count');
const liveEl = $('feed-live');
const baseTitle = document.title;

const rows = new Map();   // steamId64 -> row element (row._e holds the entry)
const latest = new Map(); // steamId64 -> newest known entry, shown or still queued
const held = [];          // entries that arrived while paused
const incoming = [];      // entries waiting to drip in
let terms = [];
let loaded = false;
let hourCount = 0;
let lastGeneratedAt = 0;
let paused = false;
let hover = false;
let releaseTimer = null;  // idle countdown until auto-release
let flushTimer = null;    // release in progress (scrolling back to top)
let lastIntent = 0;
let ignoreScrollUntil = 0;
let dripTimer = null;
let layoutKey = '';
let es = null;
let streamUp = false;
let pollTimer = null;

section.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(lang, el.dataset.i18n); });
qInput.placeholder = t(lang, 'searchPlaceholder');

function animate(el, keyframes, options) {
  try { return el.animate ? el.animate(keyframes, options) : null; } catch { return null; }
}

// ---- rows ----

function countBadge(count) {
  const x = document.createElement('span');
  x.className = 'fd-x';
  x.textContent = '×' + count;
  return x;
}

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
function graphemes(s) {
  return segmenter ? Array.from(segmenter.segment(s), g => g.segment) : Array.from(s);
}

function paint(r) {
  const e = r._e;
  const nick = r._nick;
  nick.removeAttribute('aria-label');
  nick.textContent = '';
  let pos = 0;
  for (const [a, b] of highlightRanges(e.name, terms)) {
    nick.append(e.name.slice(pos, a));
    const mark = document.createElement('mark');
    mark.textContent = e.name.slice(a, b);
    nick.append(mark);
    pos = b;
  }
  nick.append(e.name.slice(pos));
  if (e.count > 1) nick.append(countBadge(e.count));
  r._meta.textContent = ago(lang, e.lastTs, Date.now());
  r.hidden = !matchesTerms(e.name, terms);
}

// Private Steam profiles still have a public name and avatar; a small lock
// tells readers why the Dotabuff page may show little.
function lockBadge() {
  const badge = document.createElement('span');
  badge.className = 'fd-lock';
  badge.title = t(lang, 'privateProfile');
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', t(lang, 'privateProfile'));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M4 7V5a4 4 0 1 1 8 0v2h1v8H3V7h1zm2 0h4V5a2 2 0 1 0-4 0v2z');
  svg.append(path);
  badge.append(svg);
  return badge;
}

function makeRow(e) {
  const r = document.createElement('div');
  r.className = 'fd-row';
  r._e = e;
  const img = document.createElement('img');
  img.className = 'fd-av';
  img.alt = '';
  img.width = 36;
  img.height = 36;
  img.decoding = 'async';
  const src = avatarUrl(e.avatarHash);
  if (src) img.src = src;
  const av = document.createElement('span');
  av.className = 'fd-avw';
  av.append(img);
  if (e.private) av.append(lockBadge());
  const who = document.createElement('div');
  who.className = 'fd-who';
  r._nick = document.createElement('div');
  r._nick.className = 'fd-nick';
  r._meta = document.createElement('div');
  r._meta.className = 'fd-meta';
  who.append(r._nick, r._meta);
  const go = document.createElement('a');
  go.className = 'fd-go';
  go.href = 'https://www.dotabuff.com/players/' + encodeURIComponent(e.dotaId);
  go.textContent = t(lang, 'dotabuff');
  r.append(av, who, go);
  paint(r);
  return r;
}

function dropRow(r) {
  if (r._flap) clearInterval(r._flap);
  r._flap = null;
  rows.delete(r._e.steamId64);
  r.remove();
}

// One interval per row drives every glyph; it stops when done or when the
// row is dropped. Each cell already holds its final grapheme (hidden while
// spinning, so the cell has its final width) with the random glyph drawn on
// top, and the highlight and ×N badge are there from the start: the swap to
// plain text at the end changes nothing visible. Screen readers get the real
// name via aria-label.
function flap(r) {
  const e = r._e;
  const nick = r._nick;
  const ranges = highlightRanges(e.name, terms);
  nick.setAttribute('aria-label', e.name);
  nick.textContent = '';
  let offset = 0;
  const cells = graphemes(e.name).map(g => {
    const start = offset;
    offset += g.length;
    const cell = document.createElement('span');
    cell.className = 'fd-flap';
    cell.setAttribute('aria-hidden', 'true');
    if (ranges.some(([a, b]) => start >= a && start < b)) cell.classList.add('fd-hl');
    const final = document.createElement('span');
    final.className = 'fd-g';
    final.textContent = g;
    cell.append(final);
    if (/\S/.test(g)) {
      cell.classList.add('spin');
      cell._spin = document.createElement('span');
      cell._spin.className = 'fd-spin';
      cell._spin.textContent = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      cell.append(cell._spin);
    }
    nick.append(cell);
    return cell;
  });
  if (e.count > 1) nick.append(countBadge(e.count));
  const lastTick = 4 + (cells.length - 1) * 2;
  let tick = 0;
  r._flap = setInterval(() => {
    tick++;
    cells.forEach((cell, i) => {
      if (!cell._spin) return;
      if (tick >= 4 + i * 2) {
        cell._spin.remove();
        cell._spin = null;
        cell.classList.remove('spin');
        cell.classList.add('fd-flip');
      } else {
        cell._spin.textContent = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
    });
    if (tick >= lastTick) {
      clearInterval(r._flap);
      r._flap = null;
      setTimeout(() => { if (r.isConnected && !r._flap) paint(r); }, 450);
    }
  }, FLAP_TICK_MS);
  r.firstChild.classList.add('fd-flip');
  animate(r, [{ height: '0px' }, { height: ROW + 'px' }], { duration: 260, easing: 'ease-out' });
}

function notifyPinned(r) {
  r.classList.add('fd-pinned');
  if (document.hidden || !document.hasFocus()) document.title = '★ ' + baseTitle;
}

function insert(e, animated) {
  const old = rows.get(e.steamId64);
  if (old && !isNewer(e, old._e)) return; // a stale queued copy must not overwrite newer data
  if (old) dropRow(old);
  const r = makeRow(e);
  rows.set(e.steamId64, r);
  const shown = [...list.querySelectorAll('.fd-row')];
  list.insertBefore(r, shown[insertIndex(shown.map(x => x._e.lastTs), e.lastTs)] || null);
  if (animated && !r.hidden && !reduce) flap(r);
  if (loaded && terms.length && !r.hidden) notifyPinned(r);
}

// Rows past the hour are forgotten entirely; rows past the display cap only
// lose their DOM node, so the next snapshot does not resurrect them as new.
function trim() {
  const cutoff = Date.now() - HOUR_MS;
  [...list.querySelectorAll('.fd-row')].forEach((r, i) => {
    if (r._e.lastTs < cutoff || i >= MAX_ROWS) dropRow(r);
  });
  for (const [id, e] of latest) if (e.lastTs < cutoff) latest.delete(id);
}

// Rebuild time-block headers only when the grouping changed, and keep the
// scroll position so a paused reader is not moved.
function layout() {
  const now = Date.now();
  const visible = [...list.querySelectorAll('.fd-row')].filter(r => !r.hidden);
  const blocks = visible.map(r => timeBlock(r._e.lastTs, now));
  const key = visible.map((r, i) => r._e.steamId64 + ':' + blocks[i]).join('|');
  hitsEl.textContent = terms.length ? t(lang, 'hits', { n: visible.length }) : '';
  if (key === layoutKey) return;
  layoutKey = key;
  const top = list.scrollTop;
  list.querySelectorAll('.fd-blk, .fd-empty').forEach(el => el.remove());
  let current = null;
  visible.forEach((r, i) => {
    if (blocks[i] === current) return;
    current = blocks[i];
    const h = document.createElement('div');
    h.className = 'fd-blk';
    h.textContent = t(lang, current);
    list.insertBefore(h, r);
  });
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'fd-empty';
    empty.textContent = t(lang, 'empty');
    list.append(empty);
  }
  if (paused) list.scrollTop = top;
}

function renderCount() {
  countEl.textContent = t(lang, 'hourCount', { n: hourCount });
}

function removeIds(ids) {
  if (!ids.length) return;
  const gone = new Set(ids);
  for (const id of gone) {
    const r = rows.get(id);
    if (r) dropRow(r);
    latest.delete(id);
  }
  for (const q of [held, incoming]) {
    for (let i = q.length - 1; i >= 0; i--) if (gone.has(q[i].steamId64)) q.splice(i, 1);
  }
  layout();
  if (paused) renderPill();
}

// ---- drip ----

function enqueue(entries) {
  for (const e of entries) (paused ? held : incoming).push(e);
  if (paused) renderPill();
  else pump();
}

function pump() {
  if (dripTimer || paused || !incoming.length) return;
  try {
    if (incoming.length > MAX_DRIP) incoming.splice(0, incoming.length - MAX_DRIP).forEach(e => insert(e, false));
    insert(incoming.shift(), true);
    trim();
    layout();
  } catch (err) {
    console.error('feed: insert failed', err);
  }
  dripTimer = setTimeout(() => { dripTimer = null; pump(); }, dripDelay(incoming.length + 1));
}

// ---- catch / release ----
// States: live (paused = false) → paused (held collects arrivals, optional
// releaseTimer) → releasing (still paused, flushTimer pending while we scroll
// to the top) → live. Any user intent during releasing cancels it.

function atTop() { return list.scrollTop <= 2; }

function pause(ms) {
  paused = true;
  box.classList.add('paused');
  liveEl.textContent = t(lang, 'paused');
  clearTimeout(releaseTimer);
  clearTimeout(flushTimer);
  releaseTimer = null;
  flushTimer = null;
  ignoreScrollUntil = 0;
  // Rows still waiting to drip in count as held: the pill shows them and
  // nothing is inserted at the top while the reader holds the list.
  clearTimeout(dripTimer);
  dripTimer = null;
  if (incoming.length) held.unshift(...incoming.splice(0));
  try { (bar.getAnimations ? bar.getAnimations() : []).forEach(a => a.cancel()); } catch { /* old browser */ }
  if (ms) {
    releaseTimer = setTimeout(release, ms);
    if (!reduce) animate(bar, [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: ms, easing: 'linear', fill: 'forwards' });
  }
  renderPill();
}

function release() {
  clearTimeout(releaseTimer);
  releaseTimer = null;
  if (!paused || flushTimer) return;
  if (list.scrollTop > 0 && !reduce) {
    // Our own smooth scroll is not user intent; go live once it reaches the top.
    ignoreScrollUntil = Date.now() + RELEASE_FAILSAFE_MS;
    try { list.scrollTo({ top: 0, behavior: 'smooth' }); } catch { list.scrollTop = 0; }
    flushTimer = setTimeout(goLive, RELEASE_FAILSAFE_MS);
  } else {
    list.scrollTop = 0;
    goLive();
  }
}

function goLive() {
  clearTimeout(flushTimer);
  flushTimer = null;
  ignoreScrollUntil = 0;
  paused = false;
  box.classList.remove('paused');
  liveEl.textContent = t(lang, 'live');
  const backlog = held.splice(0);
  const loud = Math.max(0, backlog.length - BURST);
  backlog.slice(0, loud).forEach(e => insert(e, false));
  incoming.push(...backlog.slice(loud));
  trim();
  layout();
  pump();
}

function renderPill() {
  pillText.textContent = held.length
    ? t(lang, 'pillNew', { n: held.length })
    : t(lang, hover ? 'pillHover' : 'pill');
}

function onIntent() {
  lastIntent = Date.now();
  if (flushTimer) pause(hover ? HOVER_MAX_MS : IDLE_MS); // the reader grabbed it mid-release
}

['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach(ev => {
  list.addEventListener(ev, onIntent, { passive: true });
});
list.addEventListener('scroll', () => {
  if (flushTimer) {
    if (atTop()) goLive(); // the release scroll arrived
    return;
  }
  const now = Date.now();
  if (now < ignoreScrollUntil) return;
  // Away from the top always holds the list, including momentum scrolling
  // that outlasts the gesture which started it.
  if (!atTop()) pause(hover ? HOVER_MAX_MS : IDLE_MS);
  else if (now - lastIntent <= 900) {
    if (hover) pause(HOVER_MAX_MS);
    else release();
  }
}, { passive: true });
list.addEventListener('touchend', () => {
  if (paused && atTop()) pause(LEAVE_MS);
  else if (!atTop()) pause(IDLE_MS);
}, { passive: true });
// Touch devices synthesise mouseenter without a reliable mouseleave, so hover
// pausing is only wired up where a real pointer can hover.
if (canHover) {
  list.addEventListener('mouseenter', () => { hover = true; pause(HOVER_MAX_MS); });
  list.addEventListener('mouseleave', () => {
    hover = false;
    if (paused && !flushTimer) pause(atTop() ? LEAVE_MS : IDLE_MS);
  });
}
pill.addEventListener('click', () => { hover = false; release(); });

// ---- search ----

function setQuery(q) {
  terms = splitTerms(q);
  rows.forEach(r => { if (!r._flap) paint(r); });
  layoutKey = '';
  layout();
}

let saved = new URLSearchParams(location.search).get('q');
if (saved === null) {
  try { saved = localStorage.getItem('feed_q') || ''; } catch { saved = ''; }
}
qInput.value = saved;
terms = splitTerms(saved);
qInput.addEventListener('input', () => {
  setQuery(qInput.value);
  try { localStorage.setItem('feed_q', qInput.value); } catch { /* storage disabled */ }
  const u = new URL(location.href);
  if (qInput.value.trim()) u.searchParams.set('q', qInput.value);
  else u.searchParams.delete('q');
  history.replaceState(null, '', u);
});
window.addEventListener('focus', () => { document.title = baseTitle; });

// ---- data ----

function onData(data, isSnapshot) {
  if (isStale(data, lastGeneratedAt)) return;
  lastGeneratedAt = Math.max(lastGeneratedAt, data.generatedAt || 0);
  hourCount = data.hourCount;
  renderCount();
  const entries = data.entries || [];
  if (isSnapshot && loaded) removeIds(idsToRemove(latest, entries));
  const fresh = diffEntries(entries, latest);
  fresh.forEach(e => latest.set(e.steamId64, e));
  if (!loaded && isSnapshot) {
    fresh.forEach(e => insert(e, false));
    loaded = true;
    section.hidden = false;
    trim();
    layout();
    return;
  }
  enqueue(fresh);
}

async function poll() {
  if (streamUp) return;
  try {
    const res = await fetch('/api/recent.json');
    if (!res.ok) return;
    const data = await res.json();
    if (!streamUp) onData(data, true); // the stream came back meanwhile: its data wins
  } catch { /* offline; try again next interval */ }
}

function startPolling() {
  stopPolling();
  poll();
  pollTimer = setInterval(poll, POLL_MS + Math.round((Math.random() - 0.5) * 10000));
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function parse(ev) {
  try { return JSON.parse(ev.data); } catch { return null; }
}

function connect() {
  if (es || pollTimer || document.hidden) return; // one transport at a time; none while hidden
  if (!('EventSource' in window)) { startPolling(); return; }
  es = new EventSource('/api/stream');
  es.addEventListener('snapshot', ev => { const d = parse(ev); if (d) onData(d, true); });
  es.addEventListener('entries', ev => { const d = parse(ev); if (d) onData(d, false); });
  // While the stream is down (reconnecting or refused) keep the list fresh by
  // polling; the next successful open stops it.
  es.onopen = () => { streamUp = true; stopPolling(); };
  es.onerror = () => {
    streamUp = false;
    if (!pollTimer) startPolling();
    if (es && es.readyState === EventSource.CLOSED) es = null;
  };
}

function disconnect() {
  if (es) { es.close(); es = null; }
  streamUp = false;
  stopPolling();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) disconnect();
  else connect();
});

setInterval(() => {
  if (!loaded || document.hidden) return;
  const now = Date.now();
  rows.forEach(r => {
    if (r.hidden) return;
    const text = ago(lang, r._e.lastTs, now);
    if (r._meta.textContent !== text) r._meta.textContent = text;
  });
}, 1000);
setInterval(() => { if (loaded && !paused && !document.hidden) { trim(); layout(); } }, 15000);

connect();
