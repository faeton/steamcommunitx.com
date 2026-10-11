// Shared by the server (redirect teaser) and the browser (/assets/feed.js).
// Pure functions only: no DOM, no Node APIs.

export const AVATAR_HASH_RE = /^[0-9a-f]{40}$/;
export const HOUR_MS = 60 * 60 * 1000;
// Stats sites linked from every feed row, as small letter tiles.
export const PLAYER_SITES = [
  { key: 'd', label: 'D', site: 'Dotabuff', url: 'https://www.dotabuff.com/players/' },
  { key: 'o', label: 'O', site: 'OpenDota', url: 'https://www.opendota.com/players/' },
  { key: 's', label: 'S', site: 'STRATZ', url: 'https://stratz.com/players/' }
];
export const STEAM_PROFILE = 'https://steamcommunity.com/profiles/';
export const LOCK_PATH = 'M4 7V5a4 4 0 1 1 8 0v2h1v8H3V7h1zm2 0h4V5a2 2 0 1 0-4 0v2z';

export function avatarUrl(hash) {
  return AVATAR_HASH_RE.test(hash || '') ? `https://avatars.steamstatic.com/${hash}_medium.jpg` : '';
}

export function pickLang(tag) {
  const primary = String(tag || '').trim().toLowerCase().split(/[,;]/)[0].split('-')[0];
  if (primary === 'uk') return 'uk';
  if (primary === 'ru' || primary === 'be') return 'ru';
  return 'en';
}

const DICT = {
  en: {
    feedTitle: 'Recently checked',
    live: 'Live',
    paused: 'Paused',
    hourCount: '{n} checked this hour',
    searchPlaceholder: 'Nickname, Dota ID or a few words: akamai 123456789',
    hits: '{n} matches',
    justNow: 'Just now',
    last5: 'Last 5 min',
    lastHour: 'Last hour',
    pillNew: '⏸ Paused · {n} new · back to live ↑',
    pillHover: '⏸ Paused while hovering',
    pill: '⏸ Paused · back to live ↑',
    empty: 'Nobody checked in the last hour yet.',
    openOn: 'Open on {site}',
    agoNow: 'just now',
    agoSec: '{n}s ago',
    agoMin: '{n} min ago',
    teaserSeenOnce: 'This player was checked {ago} — see who else →',
    teaserSeenMany: 'This player was checked {ago} · ×{count} — see who else →',
    teaserHour: '{n} players checked this hour — see if you were →',
    privateProfile: 'Private Steam profile',
    agoHour: '{n} h ago',
    watchTitle: 'Watching',
    watchHint: 'last 24 h · updates live',
    watchIntro: 'Watch your team: add up to 10 Dota IDs and see when someone checks them. Share the link with teammates.',
    watchPlaceholder: 'Dota ID, SteamID or profile link',
    watchAdd: 'Add',
    watchCopy: 'Copy link',
    watchCopied: 'Copied',
    watchClear: 'Clear',
    watchRemove: 'Remove',
    watchBell: 'Sound and notification on new checks',
    watchChecked: 'checked {ago}',
    watchNone: 'no checks recorded in 24 h',
    watchNotify: '{name} was just checked'
  },
  ru: {
    feedTitle: 'Кого сейчас проверяют',
    live: 'Live',
    paused: 'Пауза',
    hourCount: '{n} за час',
    searchPlaceholder: 'Ник, Dota ID или пару слов: akamai 123456789',
    hits: 'совпадений: {n}',
    justNow: 'Только что',
    last5: 'Последние 5 мин',
    lastHour: 'Последний час',
    pillNew: '⏸ Пауза · новых: {n} · к live ↑',
    pillHover: '⏸ Пауза, пока курсор на ленте',
    pill: '⏸ Пауза · к live ↑',
    empty: 'За последний час никого не проверяли.',
    openOn: 'Открыть на {site}',
    agoNow: 'только что',
    agoSec: '{n} сек назад',
    agoMin: '{n} мин назад',
    teaserSeenOnce: 'Этого игрока проверяли {ago} — посмотри, кого ещё →',
    teaserSeenMany: 'Этого игрока проверяли {ago} · ×{count} — посмотри, кого ещё →',
    teaserHour: 'Проверок за час: {n} — проверь, нет ли тебя →',
    privateProfile: 'Приватный профиль Steam',
    agoHour: '{n} ч назад',
    watchTitle: 'Слежу',
    watchHint: 'за 24 ч · обновляется вживую',
    watchIntro: 'Следи за своей командой: добавь до 10 Dota ID и увидишь, когда их проверят. Скинь ссылку тиммейтам.',
    watchPlaceholder: 'Dota ID, SteamID или ссылка на профиль',
    watchAdd: 'Добавить',
    watchCopy: 'Скопировать ссылку',
    watchCopied: 'Скопировано',
    watchClear: 'Очистить',
    watchRemove: 'Убрать',
    watchBell: 'Звук и уведомление о новых проверках',
    watchChecked: 'проверяли {ago}',
    watchNone: 'проверок за 24 ч не записано',
    watchNotify: '{name} только что проверили'
  },
  uk: {
    feedTitle: 'Кого зараз перевіряють',
    live: 'Live',
    paused: 'Пауза',
    hourCount: '{n} за годину',
    searchPlaceholder: 'Нік, Dota ID або кілька слів: akamai 123456789',
    hits: 'збігів: {n}',
    justNow: 'Щойно',
    last5: 'Останні 5 хв',
    lastHour: 'Остання година',
    pillNew: '⏸ Пауза · нових: {n} · до live ↑',
    pillHover: '⏸ Пауза, поки курсор на стрічці',
    pill: '⏸ Пауза · до live ↑',
    empty: 'За останню годину нікого не перевіряли.',
    openOn: 'Відкрити на {site}',
    agoNow: 'щойно',
    agoSec: '{n} с тому',
    agoMin: '{n} хв тому',
    teaserSeenOnce: 'Цього гравця перевіряли {ago} — подивись, кого ще →',
    teaserSeenMany: 'Цього гравця перевіряли {ago} · ×{count} — подивись, кого ще →',
    teaserHour: 'Перевірок за годину: {n} — перевір, чи немає тебе →',
    privateProfile: 'Приватний профіль Steam',
    agoHour: '{n} год тому',
    watchTitle: 'Стежу',
    watchHint: 'за 24 год · оновлюється наживо',
    watchIntro: 'Стеж за своєю командою: додай до 10 Dota ID і побачиш, коли їх перевірять. Скинь посилання тімейтам.',
    watchPlaceholder: 'Dota ID, SteamID або посилання на профіль',
    watchAdd: 'Додати',
    watchCopy: 'Скопіювати посилання',
    watchCopied: 'Скопійовано',
    watchClear: 'Очистити',
    watchRemove: 'Прибрати',
    watchBell: 'Звук і сповіщення про нові перевірки',
    watchChecked: 'перевіряли {ago}',
    watchNone: 'перевірок за 24 год не записано',
    watchNotify: '{name} щойно перевірили'
  }
};

export function t(lang, key, vars = {}) {
  const s = (DICT[lang] && DICT[lang][key]) ?? DICT.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

export function ago(lang, ts, now) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return t(lang, 'agoNow');
  if (s < 60) return t(lang, 'agoSec', { n: s });
  if (s < 3600) return t(lang, 'agoMin', { n: Math.floor(s / 60) });
  return t(lang, 'agoHour', { n: Math.floor(s / 3600) });
}

// Second line of a feed row: the Dota account ID, then how long ago.
export function metaLine(lang, entry, now) {
  return `id ${entry.dotaId} · ${ago(lang, entry.lastTs, now)}`;
}

// Second line of a watchlist row.
export function watchMeta(lang, item, now) {
  const status = item.lastTs == null ? t(lang, 'watchNone') : t(lang, 'watchChecked', { ago: ago(lang, item.lastTs, now) });
  return `id ${item.dotaId} · ${status}`;
}

export function normalize(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase();
}

export function splitTerms(q) {
  return normalize(q).split(/\s+/).filter(Boolean);
}

export function matchesTerms(name, terms) {
  if (!terms.length) return true;
  const n = normalize(name);
  return terms.some(term => n.includes(term));
}

// A row matches when any word is in the nickname, or any run of 4+ digits in
// a word is part of its Dota or Steam ID, so a pasted profile URL or
// [U:1:x] finds the player too.
export function matchesEntry(entry, terms) {
  if (!terms.length) return true;
  if (matchesTerms(entry.name, terms)) return true;
  const ids = `${entry.dotaId || ''} ${entry.steamId64 || ''}`;
  return terms.some(term => (term.match(/\d{4,}/g) || []).some(digits => ids.includes(digits)));
}

// Ranges index into the original string, so they are only reliable when
// normalisation keeps the length; otherwise no highlight (the row still matches).
export function highlightRanges(name, terms) {
  const n = normalize(name);
  if (!terms.length || n.length !== String(name).length) return [];
  const ranges = [];
  for (const term of terms) {
    let i = n.indexOf(term);
    while (i !== -1) {
      ranges.push([i, i + term.length]);
      i = n.indexOf(term, i + term.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

export function timeBlock(ts, now) {
  const s = (now - ts) / 1000;
  if (s < 60) return 'justNow';
  if (s < 300) return 'last5';
  return 'lastHour';
}

export function dripDelay(queueLen, windowMs = 30000) {
  if (queueLen <= 0) return 0;
  return Math.min(3000, Math.max(400, Math.floor(windowMs / queueLen)));
}

// a supersedes b: a later check, or the same millisecond with a higher count.
export function isNewer(a, b) {
  return !b || a.lastTs > b.lastTs || (a.lastTs === b.lastTs && a.count > b.count);
}

export function diffEntries(entries, known) {
  return entries
    .filter(e => isNewer(e, known.get(e.steamId64)))
    .sort((a, b) => a.lastTs - b.lastTs);
}

// Snapshots are authoritative: anything shown but absent (e.g. an account
// Steam stopped returning) is removed. A snapshot cut at `limit` only covers its own time range.
export function idsToRemove(shown, entries, limit = 200) {
  const present = new Set(entries.map(e => e.steamId64));
  const floor = entries.length >= limit ? Math.min(...entries.map(e => e.lastTs)) : -Infinity;
  return [...shown].filter(([id, e]) => !present.has(id) && e.lastTs >= floor).map(([id]) => id);
}

// Polls can overlap and transports switch, so an older payload may arrive
// after a newer one; applying it would roll the list back.
export function isStale(data, lastGeneratedAt) {
  return typeof data.generatedAt === 'number' && data.generatedAt < lastGeneratedAt;
}

// Position for a row in a list sorted by lastTs, newest first. A player
// enriched late can be older than rows already shown.
export function insertIndex(timestamps, ts) {
  const i = timestamps.findIndex(other => other <= ts);
  return i === -1 ? timestamps.length : i;
}

// ---- columns by tempo ----
// When checks arrive fast (Battle Cup Saturdays) one reel moves too quickly
// to read, so the feed splits into 2-3 independent reels. Thresholds are in
// rows per minute; going down needs a clearly lower rate (hysteresis).
export const TEMPO_WINDOW_MS = 120_000;
const UP = [Infinity, 20, 45];   // from n columns to n + 1 at >= UP[n]
const DOWN = [0, 0, 12, 30];     // from n columns to n - 1 below DOWN[n]

export function tempoPerMin(times, now, windowMs = TEMPO_WINDOW_MS) {
  const n = times.filter(ts => now - ts <= windowMs).length;
  return n * 60_000 / windowMs;
}

// One step per call (1 -> 2 -> 3), so a burst never jumps straight to three
// reels; the width cap applies at once.
export function nextColumns(current, perMin, maxCols) {
  let n = current;
  if (n < 3 && perMin >= UP[n]) n++;
  else if (n > 1 && perMin < DOWN[n]) n--;
  return Math.max(1, Math.min(n, maxCols));
}

export function maxColumnsFor(width) {
  if (width >= 680) return 3;
  if (width >= 520) return 2;
  return 1;
}

export function pickColumn(lastChanged) {
  let best = 0;
  for (let i = 1; i < lastChanged.length; i++) if (lastChanged[i] < lastChanged[best]) best = i;
  return best;
}

// Reels actually shown: the tempo's choice, capped by width, and always one
// while a filter is active (it is applied at once, even while paused).
export function shownColumns(tempoCols, filtering, width) {
  return filtering ? 1 : Math.min(tempoCols, maxColumnsFor(width));
}

// Queued rows (held while paused, or waiting to drip): one newest entry per
// player, oldest first, and at most `cap` of them (the newest win).
export function foldQueue(queue, cap) {
  const newest = new Map();
  for (const e of queue) {
    const prev = newest.get(e.steamId64);
    if (isNewer(e, prev)) newest.set(e.steamId64, e);
  }
  return [...newest.values()].sort((a, b) => a.lastTs - b.lastTs).slice(-cap);
}

// ---- check watchlist (?check=) ----

export const MAX_WATCH = 10;
const MAX_CHECK_RAW = 1024;
const STEAM64_BASE = 76561197960265728n;
const ACCOUNT_LIMIT = 2n ** 32n;

function tokenAccount(token) {
  let s = token;
  try { s = decodeURIComponent(s); } catch { /* malformed escape: use as is */ }
  const steam3 = /^\[?U:1:(\d{1,10})\]?$/i.exec(s);
  if (steam3) s = steam3[1];
  const path = /\/(?:profiles|players)\/(\d+)(?:[/?#]|$)/.exec(s);
  if (path) s = path[1];
  let n;
  if (/^\d{17}$/.test(s)) n = BigInt(s) - STEAM64_BASE;
  else if (/^\d{1,10}$/.test(s)) n = BigInt(s);
  else return null;
  return n >= 1n && n < ACCOUNT_LIMIT ? n.toString() : null;
}

// Dota account ids (canonical decimal, deduplicated, input order, at most
// MAX_WATCH) from a ?check value, a list of them, or pasted text. Only these
// digits ever reach HTML, URLs or storage.
export function parseCheckList(raw) {
  const text = (Array.isArray(raw) ? raw.join(',') : String(raw ?? ''));
  if (text.length > MAX_CHECK_RAW) return [];
  const out = [];
  for (const token of text.split(/[\s,+;]+/)) {
    if (!token) continue;
    const id = tokenAccount(token);
    if (id && !out.includes(id)) out.push(id);
    if (out.length === MAX_WATCH) break;
  }
  return out;
}

export function accountToSteamId64(account) {
  return (STEAM64_BASE + BigInt(account)).toString();
}

// Ids from a fresh status poll whose latest check is newer than what was seen
// before. An id without a baseline yet only gets one (adding never notifies).
export function watchNews(baseline, items) {
  return items.filter(it => {
    const prev = baseline.get(it.dotaId);
    return prev && it.lastTs != null && (prev.lastTs == null || it.lastTs > prev.lastTs);
  }).map(it => it.dotaId);
}

// Tab title while the visitor is away: new watchlist checks, then the feed's
// "a search match arrived" star.
export function titleText(base, count, star) {
  return (count > 0 ? `(${count}) ` : '') + (star ? '★ ' : '') + base;
}
