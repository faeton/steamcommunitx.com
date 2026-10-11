// Watchlist (?check=): up to 10 Dota ids a team shares as one link. Shows
// when each was last checked here (24 h) and signals new checks, also from a
// background tab. Status comes from polling /api/check.json; the feed stream
// only nudges an earlier refresh (it carries enriched players ~30 s later).
// Names go through text nodes only, never innerHTML.
import {
  t, pickLang, avatarUrl, parseCheckList, accountToSteamId64, watchMeta, watchNews, MAX_WATCH,
  PLAYER_SITES, STEAM_PROFILE, LOCK_PATH
} from './feed-shared.js';
import { addCount, away } from './title.js';

const POLL_MS = 20000;
const LIMITED_MS = 60000;
const NUDGE_MS = 1000;
const STORE_KEY = 'watch_ids';
const BELL_KEY = 'watch_bell';

const lang = pickLang(navigator.language);
const $ = id => document.getElementById(id);
const root = $('watch');

let list = [];
let watched = new Set();            // SteamID64s of the list, for the board
const status = new Map();           // dotaId -> latest status item
let pollTimer = null;
let nudgeTimer = null;
let inFlight = false;
let bell = false;
let audio = null;
let changeHandler = () => {};

export function watching(steamId64) {
  return watched.has(steamId64);
}

export function onWatchChange(fn) {
  changeHandler = fn;
}

// A live feed entry for a watched player: refresh now instead of at the next poll.
export function onFeedEntries(entries) {
  if (!root || !entries.some(e => watched.has(e.steamId64))) return;
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(refresh, NUDGE_MS);
}

function storage(fn) {
  try { return fn(localStorage); } catch { return null; } // storage disabled
}

// ---- rows ----

function lockBadge() {
  const badge = document.createElement('span');
  badge.className = 'fd-lock';
  badge.title = t(lang, 'privateProfile');
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', badge.title);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', LOCK_PATH);
  svg.append(path);
  badge.append(svg);
  return badge;
}

function makeRow(id) {
  const item = status.get(id) || null;
  const r = document.createElement('div');
  r.className = 'wt-row' + (item && item.lastTs != null ? ' wt-hit' : '');
  r.dataset.id = id;
  const av = document.createElement('span');
  av.className = 'fd-avw';
  const img = document.createElement('img');
  img.className = 'fd-av';
  img.alt = '';
  img.width = 36;
  img.height = 36;
  img.decoding = 'async';
  const src = item ? avatarUrl(item.avatarHash) : '';
  if (src) img.src = src;
  av.append(img);
  if (item && item.private) av.append(lockBadge());
  const who = document.createElement('div');
  who.className = 'fd-who';
  const nick = document.createElement('div');
  nick.className = 'fd-nick';
  const name = document.createElement('a');
  name.className = 'fd-name';
  name.href = STEAM_PROFILE + accountToSteamId64(id);
  name.textContent = name.title = (item && item.name) || id;
  nick.append(name);
  if (item && item.count > 1) {
    const x = document.createElement('span');
    x.className = 'fd-x';
    x.textContent = '×' + item.count;
    nick.append(x);
  }
  const meta = document.createElement('div');
  meta.className = 'fd-meta';
  meta.textContent = item ? watchMeta(lang, { ...item, dotaId: id }, Date.now()) : 'id ' + id;
  who.append(nick, meta);
  const links = document.createElement('span');
  links.className = 'fd-links';
  for (const p of PLAYER_SITES) {
    const go = document.createElement('a');
    go.className = 'fd-go fd-go-' + p.key;
    go.href = p.url + id;
    go.title = t(lang, 'openOn', { site: p.site });
    go.textContent = p.label;
    links.append(go);
  }
  const x = document.createElement('button');
  x.className = 'wt-x';
  x.type = 'button';
  x.title = t(lang, 'watchRemove');
  x.setAttribute('aria-label', x.title);
  x.textContent = '×';
  r.append(av, who, links, x);
  return r;
}

function render(flash = []) {
  const box = $('watch-list');
  box.replaceChildren(...list.map(makeRow));
  for (const id of flash) box.querySelector(`[data-id="${id}"]`)?.classList.add('wt-new');
  // Long nicknames fade out like on the board.
  requestAnimationFrame(() => box.querySelectorAll('.fd-name').forEach(n => n.classList.toggle('fd-fade', n.scrollWidth > n.clientWidth)));
  root.classList.toggle('wt-empty', !list.length);
  root.classList.toggle('wt-full', list.length >= MAX_WATCH);
}

function tick() {
  const now = Date.now();
  for (const row of $('watch-list').children) {
    const item = status.get(row.dataset.id);
    if (!item || item.lastTs == null) continue;
    const meta = row.querySelector('.fd-meta');
    const text = watchMeta(lang, { ...item, dotaId: row.dataset.id }, now);
    if (meta.textContent !== text) meta.textContent = text;
  }
}

// ---- list ----

function shareUrl() {
  return location.origin + '/?check=' + list.join(',');
}

// Rewrite only the check parameter; the feed's own q filter stays.
function syncUrl() {
  const u = new URL(location.href);
  u.searchParams.delete('check');
  const rest = u.searchParams.toString();
  u.search = [list.length ? 'check=' + list.join(',') : '', rest].filter(Boolean).join('&');
  history.replaceState(history.state, '', u);
}

function setList(next) {
  list = next;
  watched = new Set(list.map(accountToSteamId64));
  for (const id of status.keys()) if (!list.includes(id)) status.delete(id);
  storage(s => list.length ? s.setItem(STORE_KEY, list.join(',')) : s.removeItem(STORE_KEY));
  syncUrl();
  render();
  changeHandler();
}

// ---- status ----

function apply(items, notify) {
  const fresh = items.filter(it => list.includes(String(it.dotaId)));
  const news = notify ? watchNews(status, fresh) : [];
  for (const it of fresh) status.set(String(it.dotaId), it);
  render(news);
  if (news.length) announce(news);
}

async function refresh() {
  clearTimeout(pollTimer);
  clearTimeout(nudgeTimer);
  if (!list.length || inFlight) { schedule(POLL_MS); return; }
  inFlight = true;
  const asked = list.join(',');
  let wait = POLL_MS;
  try {
    const res = await fetch('/api/check.json?ids=' + asked, { cache: 'no-store' });
    if (res.status === 429) wait = LIMITED_MS;
    else if (res.ok) {
      const data = await res.json();
      // Ids that got no baseline yet (just added) only get one now.
      if (list.join(',') === asked) apply(data.items || [], true);
    }
  } catch { /* offline; try again at the next poll */ }
  inFlight = false;
  schedule(wait);
}

function schedule(ms) {
  clearTimeout(pollTimer);
  if (list.length) pollTimer = setTimeout(refresh, ms);
}

// ---- signals ----

function chime() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const now = audio.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + i * 0.14);
      g.gain.exponentialRampToValueAtTime(0.2, now + i * 0.14 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.3);
      o.connect(g).connect(audio.destination);
      o.start(now + i * 0.14);
      o.stop(now + i * 0.14 + 0.32);
    });
  } catch { /* no audio */ }
}

function announce(ids) {
  addCount(ids.length);
  if (!bell) return;
  chime();
  if (!away() || !('Notification' in window) || Notification.permission !== 'granted') return;
  const names = ids.map(id => (status.get(id) && status.get(id).name) || id).join(', ');
  try {
    const n = new Notification(t(lang, 'watchNotify', { name: names }), { tag: 'watch', body: location.host });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* some browsers only allow notifications from a service worker */ }
}

function setBell(on) {
  bell = on;
  $('watch-bell').setAttribute('aria-pressed', String(on));
  storage(s => on ? s.setItem(BELL_KEY, '1') : s.removeItem(BELL_KEY));
}

// ---- controls ----

function wire() {
  $('watch-add').addEventListener('submit', ev => {
    ev.preventDefault();
    const input = $('watch-in');
    const added = parseCheckList(input.value);
    const next = parseCheckList([...list, ...added]);
    if (!added.length) { input.setAttribute('aria-invalid', 'true'); return; }
    input.removeAttribute('aria-invalid');
    input.value = '';
    if (next.join(',') !== list.join(',')) { setList(next); refresh(); }
  });
  $('watch-in').addEventListener('input', ev => ev.target.removeAttribute('aria-invalid'));
  $('watch-list').addEventListener('click', ev => {
    const x = ev.target.closest('.wt-x');
    if (!x) return;
    const id = x.closest('.wt-row').dataset.id;
    setList(list.filter(v => v !== id));
  });
  $('watch-clear').addEventListener('click', () => setList([]));
  $('watch-copy').addEventListener('click', async ev => {
    const btn = ev.currentTarget;
    try {
      await navigator.clipboard.writeText(shareUrl());
      btn.textContent = t(lang, 'watchCopied');
      setTimeout(() => { btn.textContent = t(lang, 'watchCopy'); }, 1500);
    } catch {
      const input = $('watch-in');
      input.value = shareUrl();
      input.select();
    }
  });
  $('watch-bell').addEventListener('click', () => {
    setBell(!bell);
    if (!bell) return;
    chime(); // also unlocks audio for later, from this user gesture
    if ('Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch { /* old callback-only API */ }
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && list.length) refresh(); });
}

function init() {
  let data = { list: [], watch: null };
  try { data = JSON.parse($('check-data').textContent); } catch (err) { console.error('watch: embedded data unreadable', err); }
  // Same language as the feed (the browser's), whatever the server guessed.
  const label = (sel, key) => { const el = root.querySelector(sel); if (el) el.textContent = t(lang, key); };
  label('.wt-head h2', 'watchTitle');
  label('.wt-hint', 'watchHint');
  label('.wt-intro', 'watchIntro');
  label('#watch-copy', 'watchCopy');
  label('#watch-clear', 'watchClear');
  label('.wt-add button', 'watchAdd');
  $('watch-in').placeholder = t(lang, 'watchPlaceholder');
  $('watch-bell').title = t(lang, 'watchBell');
  wire();
  setBell(storage(s => s.getItem(BELL_KEY)) === '1');
  if (data.watch) for (const it of data.watch.items || []) status.set(String(it.dotaId), it);
  const fromUrl = parseCheckList(data.list || []);
  // A shared link adopts its set; a bare visit restores the last one.
  setList(fromUrl.length ? fromUrl : parseCheckList(storage(s => s.getItem(STORE_KEY)) || ''));
  if (list.length) data.watch ? schedule(POLL_MS) : refresh();
  setInterval(() => { if (!document.hidden) tick(); }, 1000);
}

if (root) init();
