// Tracks whether the Steam Web API is usable, so /healthz (and the uptime
// check behind it) notices a revoked key or a Steam outage instead of only
// "the process is up". Runtime-agnostic; the Node server wires it in as
// env.STEAM_HEALTH. Reporters: vanity resolution (core) and persona
// enrichment (feed).
const WINDOW_MS = 15 * 60 * 1000;
const MIN_FAILURES = 3;

export class SteamHealth {
  constructor({ hasKeys, clock = Date.now }) {
    this.hasKeys = hasKeys;
    this.clock = clock;
    this.okAt = null;
    this.errorAt = null;
    this.lastError = '';
    this.failuresInRow = 0;
    this.runStartedAt = null;
    this.calls = { vanity: { ok: 0, fail: 0 }, summaries: { ok: 0, fail: 0 } };
  }

  ok(kind) {
    this.calls[kind] && this.calls[kind].ok++;
    this.okAt = this.clock();
    this.failuresInRow = 0;
    this.runStartedAt = null;
  }

  fail(kind, error) {
    this.calls[kind] && this.calls[kind].fail++;
    const now = this.clock();
    this.errorAt = now;
    this.lastError = String(error?.message || error || 'unknown error').slice(0, 200);
    if (this.failuresInRow === 0) this.runStartedAt = now;
    this.failuresInRow++;
  }

  // Unhealthy: no keys at all, or only failures for 15+ minutes (at least 3)
  // with the latest one recent. Old failures with no new traffic since do
  // not keep it red: nothing says Steam is still down.
  status() {
    const now = this.clock();
    let reason = '';
    if (!this.hasKeys) reason = 'no Steam API keys configured';
    else if (this.failuresInRow >= MIN_FAILURES
      && now - this.runStartedAt >= WINDOW_MS
      && now - this.errorAt < WINDOW_MS) reason = `Steam API failing: ${this.lastError}`;
    return {
      healthy: !reason, reason, okAt: this.okAt, errorAt: this.errorAt,
      failuresInRow: this.failuresInRow, calls: this.calls
    };
  }
}
