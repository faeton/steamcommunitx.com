import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SteamHealth } from '../src/steam-health.js';

function clockAt(start) {
  const c = () => c.now;
  c.now = start;
  return c;
}

test('SteamHealth: healthy with keys and no traffic; unhealthy without keys', () => {
  const clock = clockAt(1_000_000);
  assert.equal(new SteamHealth({ hasKeys: true, clock }).status().healthy, true);
  const none = new SteamHealth({ hasKeys: false, clock }).status();
  assert.equal(none.healthy, false);
  assert.match(none.reason, /no Steam API keys/);
});

test('SteamHealth: only a sustained run of failures with no success is unhealthy', () => {
  const clock = clockAt(1_000_000);
  const h = new SteamHealth({ hasKeys: true, clock });
  h.ok('vanity');
  clock.now += 60_000;
  h.fail('summaries', new Error('Steam HTTP 500'));
  h.fail('vanity', new Error('timeout'));
  h.fail('vanity', new Error('timeout'));
  assert.equal(h.status().healthy, true); // recent success, failures just started
  clock.now += 16 * 60_000;
  h.fail('summaries', new Error('Steam rejected API key (403)'));
  const s = h.status();
  assert.equal(s.healthy, false);
  assert.match(s.reason, /403/);
  assert.equal(s.failuresInRow, 4);
  assert.deepEqual(s.calls, { vanity: { ok: 1, fail: 2 }, summaries: { ok: 0, fail: 2 } });
  h.ok('summaries');
  assert.equal(h.status().healthy, true);
  assert.equal(h.status().failuresInRow, 0);
});

test('SteamHealth: old failures without new traffic do not keep it red forever', () => {
  const clock = clockAt(1_000_000);
  const h = new SteamHealth({ hasKeys: true, clock });
  for (let i = 0; i < 5; i++) h.fail('vanity', new Error('x'));
  clock.now += 20 * 60_000;
  h.fail('vanity', new Error('x'));
  assert.equal(h.status().healthy, false);
  clock.now += 20 * 60_000; // quiet since: nothing tells us Steam is still down
  assert.equal(h.status().healthy, true);
});
