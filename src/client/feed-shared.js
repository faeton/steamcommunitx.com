// Shared by the server (redirect teaser) and the browser (/assets/feed.js).
// Pure functions only: no DOM, no Node APIs.

export const AVATAR_HASH_RE = /^[0-9a-f]{40}$/;
export const HOUR_MS = 60 * 60 * 1000;

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
    searchPlaceholder: 'Your nickname or a few words: akamai kvyze',
    hits: '{n} matches',
    justNow: 'Just now',
    last5: 'Last 5 min',
    lastHour: 'Last hour',
    pillNew: '⏸ Paused · {n} new · back to live ↑',
    pillHover: '⏸ Paused while hovering',
    pill: '⏸ Paused · back to live ↑',
    empty: 'Nobody checked in the last hour yet.',
    dotabuff: 'Open on Dotabuff',
    agoNow: 'just now',
    agoSec: '{n}s ago',
    agoMin: '{n} min ago',
    teaserSeenOnce: 'This player was checked {ago} — see who else →',
    teaserSeenMany: 'This player was checked {ago} · ×{count} — see who else →',
    teaserHour: '{n} players checked this hour — see if you were →',
    privateProfile: 'Private Steam profile'
  },
  ru: {
    feedTitle: 'Кого сейчас проверяют',
    live: 'Live',
    paused: 'Пауза',
    hourCount: '{n} за час',
    searchPlaceholder: 'Свой ник или пару слов: akamai kvyze',
    hits: 'совпадений: {n}',
    justNow: 'Только что',
    last5: 'Последние 5 мин',
    lastHour: 'Последний час',
    pillNew: '⏸ Пауза · новых: {n} · к live ↑',
    pillHover: '⏸ Пауза, пока курсор на ленте',
    pill: '⏸ Пауза · к live ↑',
    empty: 'За последний час никого не проверяли.',
    dotabuff: 'Открыть на Dotabuff',
    agoNow: 'только что',
    agoSec: '{n} сек назад',
    agoMin: '{n} мин назад',
    teaserSeenOnce: 'Этого игрока проверяли {ago} — посмотри, кого ещё →',
    teaserSeenMany: 'Этого игрока проверяли {ago} · ×{count} — посмотри, кого ещё →',
    teaserHour: 'Проверок за час: {n} — проверь, нет ли тебя →',
    privateProfile: 'Приватный профиль Steam'
  },
  uk: {
    feedTitle: 'Кого зараз перевіряють',
    live: 'Live',
    paused: 'Пауза',
    hourCount: '{n} за годину',
    searchPlaceholder: 'Свій нік або кілька слів: akamai kvyze',
    hits: 'збігів: {n}',
    justNow: 'Щойно',
    last5: 'Останні 5 хв',
    lastHour: 'Остання година',
    pillNew: '⏸ Пауза · нових: {n} · до live ↑',
    pillHover: '⏸ Пауза, поки курсор на стрічці',
    pill: '⏸ Пауза · до live ↑',
    empty: 'За останню годину нікого не перевіряли.',
    dotabuff: 'Відкрити на Dotabuff',
    agoNow: 'щойно',
    agoSec: '{n} с тому',
    agoMin: '{n} хв тому',
    teaserSeenOnce: 'Цього гравця перевіряли {ago} — подивись, кого ще →',
    teaserSeenMany: 'Цього гравця перевіряли {ago} · ×{count} — подивись, кого ще →',
    teaserHour: 'Перевірок за годину: {n} — перевір, чи немає тебе →',
    privateProfile: 'Приватний профіль Steam'
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
  return t(lang, 'agoMin', { n: Math.floor(s / 60) });
}

// Second line of a feed row: the Dota account ID, then how long ago.
export function metaLine(lang, entry, now) {
  return `id ${entry.dotaId} · ${ago(lang, entry.lastTs, now)}`;
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

export function nextColumns(current, perMin, maxCols) {
  let n = current;
  while (n < 3 && perMin >= UP[n]) n++;
  while (n > 1 && perMin < DOWN[n]) n--;
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
