import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sanitizeName, maskBlocked, loadWords } from '../src/feed/sanitize.js';

test('sanitizeName: strips control and bidi characters', () => {
  assert.equal(sanitizeName('abc‮def\u0007'), 'abcdef');
  assert.equal(sanitizeName('⁦x⁩'), 'x');
});

test('sanitizeName: caps combining marks (anti-zalgo)', () => {
  assert.equal(sanitizeName('a' + '́'.repeat(12)), 'á́');
});

test('sanitizeName: caps length at 32 graphemes, keeps emoji whole', () => {
  assert.equal(sanitizeName('x'.repeat(50)).length, 32);
  const flags = '🇺🇦'.repeat(40);
  assert.equal(sanitizeName(flags), '🇺🇦'.repeat(32));
});

test('sanitizeName: markup stays literal text (escaping is the renderer\'s job)', () => {
  assert.equal(sanitizeName('<script>alert(1)</script>'), '<script>alert(1)</script>');
});

test('sanitizeName: empty result falls back to an em dash', () => {
  assert.equal(sanitizeName('‮\u0000'), '—');
  assert.equal(sanitizeName(undefined), '—');
});

test('maskBlocked: case-insensitive after NFKC, length-preserving bullets', () => {
  assert.equal(maskBlocked('Hello BADWORD x', ['badword']), 'Hello ••••••• x');
  assert.equal(maskBlocked('ｂａｄｗｏｒｄ', ['badword']), '•••••••');
  assert.equal(maskBlocked('clean', ['badword']), 'clean');
  assert.equal(sanitizeName('my badword nick', ['badword']), 'my ••••••• nick');
});

test('loadWords: comments, blanks, NFKC folding, missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-lists-'));
  const words = join(dir, 'words.txt');
  writeFileSync(words, '# comment\nBadWord\n\n  ｓｌｕｒ  \n');
  assert.deepEqual(loadWords(words), ['badword', 'slur']);
  const quiet = { warn() {} };
  assert.deepEqual(loadWords(join(dir, 'missing.txt'), quiet), []);
  assert.deepEqual(loadWords(undefined), []);
});
