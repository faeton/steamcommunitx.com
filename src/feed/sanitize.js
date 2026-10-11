import { readFileSync } from 'node:fs';

const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
const BIDI_RE = /[؜‎‏‪-‮⁦-⁩]/g;
const EXCESS_MARKS_RE = /(\p{M}{2})\p{M}+/gu;
const MAX_GRAPHEMES = 32;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

// Steam persona names are arbitrary Unicode. Clean them once, before storing,
// so every consumer (JSON, SSE, teaser) gets the same safe text.
export function sanitizeName(raw, blockedWords = []) {
  let s = String(raw ?? '')
    .replace(CONTROL_RE, '')
    .replace(BIDI_RE, '')
    .replace(EXCESS_MARKS_RE, '$1')
    .trim();
  const graphemes = Array.from(segmenter.segment(s), g => g.segment);
  if (graphemes.length > MAX_GRAPHEMES) s = graphemes.slice(0, MAX_GRAPHEMES).join('');
  if (blockedWords.length) s = maskBlocked(s, blockedWords);
  return s || '—';
}

export function maskBlocked(s, blockedWords) {
  const folded = s.normalize('NFKC');
  let lower = folded.toLowerCase();
  if (lower.length !== folded.length) lower = folded;
  let out = folded;
  let hit = false;
  for (const word of blockedWords) {
    if (!word) continue;
    let i = lower.indexOf(word);
    while (i !== -1) {
      const mask = '•'.repeat(word.length);
      out = out.slice(0, i) + mask + out.slice(i + word.length);
      lower = lower.slice(0, i) + mask + lower.slice(i + word.length);
      hit = true;
      i = lower.indexOf(word, i + word.length);
    }
  }
  return hit ? out : s;
}

function readLines(path, log) {
  if (!path) return [];
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch (e) {
    log.warn(`Could not read ${path}: ${e.message}`);
    return [];
  }
}

export function loadWords(path, log = console) {
  return readLines(path, log).map(w => w.normalize('NFKC').toLowerCase());
}

