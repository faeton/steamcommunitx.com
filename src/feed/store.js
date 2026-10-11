import { DatabaseSync } from 'node:sqlite';

const DAY_MS = 24 * 60 * 60 * 1000;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS pending (steamid TEXT PRIMARY KEY, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, hits INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS players (steamid TEXT PRIMARY KEY, name TEXT NOT NULL, avatar_hash TEXT NOT NULL, found INTEGER NOT NULL, private INTEGER NOT NULL, fetched_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS checks (steamid TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS checks_ts ON checks(ts);
CREATE INDEX IF NOT EXISTS checks_steamid_ts ON checks(steamid, ts);
`;

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

// Same surface as the Workers KV binding methods the core uses, so getId()
// and the API-key health helpers run unchanged under Node.
export class SqliteKV {
  constructor(db, namespace, clock = Date.now) {
    this.prefix = `${namespace}:`;
    this.clock = clock;
    this.getStmt = db.prepare('SELECT value, expires_at FROM kv WHERE key = ?');
    this.putStmt = db.prepare(
      'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at'
    );
    this.delStmt = db.prepare('DELETE FROM kv WHERE key = ?');
  }

  async get(key) {
    const row = this.getStmt.get(this.prefix + key);
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= this.clock()) {
      this.delStmt.run(this.prefix + key);
      return null;
    }
    return row.value;
  }

  async put(key, value, options = {}) {
    const ttl = Number(options.expirationTtl);
    const expiresAt = Number.isFinite(ttl) && ttl > 0 ? this.clock() + ttl * 1000 : null;
    this.putStmt.run(this.prefix + key, String(value), expiresAt);
  }

  async delete(key) {
    this.delStmt.run(this.prefix + key);
  }
}

export class FeedStore {
  constructor(db, clock = Date.now) {
    this.db = db;
    this.clock = clock;
    this.s = {
      insertCheck: db.prepare('INSERT INTO checks (steamid, ts) VALUES (?, ?)'),
      upsertPending: db.prepare(
        'INSERT INTO pending (steamid, first_ts, last_ts, hits) VALUES (?, ?, ?, 1) ' +
        'ON CONFLICT(steamid) DO UPDATE SET last_ts = excluded.last_ts, hits = hits + 1'
      ),
      takePending: db.prepare('SELECT steamid FROM pending ORDER BY first_ts LIMIT ?'),
      pendingCount: db.prepare('SELECT COUNT(*) AS n FROM pending'),
      deletePending: db.prepare('DELETE FROM pending WHERE steamid = ?'),
      upsertPlayer: db.prepare(
        'INSERT INTO players (steamid, name, avatar_hash, found, private, fetched_at) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(steamid) DO UPDATE SET name = excluded.name, avatar_hash = excluded.avatar_hash, ' +
        'found = excluded.found, private = excluded.private, fetched_at = excluded.fetched_at'
      ),
      getPlayer: db.prepare(
        'SELECT steamid, name, avatar_hash AS avatarHash, found, private, fetched_at AS fetchedAt FROM players WHERE steamid = ?'
      ),
      recent: db.prepare(
        'SELECT c.steamid AS steamId64, p.name AS name, p.avatar_hash AS avatarHash, p.private AS private, ' +
        'MAX(c.ts) AS lastTs, COUNT(*) AS count ' +
        'FROM checks c JOIN players p ON p.steamid = c.steamid ' +
        'WHERE c.ts >= ? AND p.found = 1 ' +
        'GROUP BY c.steamid ORDER BY lastTs DESC LIMIT ?'
      ),
      // Counts the same players the list shows (enriched and returned by Steam).
      hourCount: db.prepare('SELECT COUNT(DISTINCT c.steamid) AS n FROM checks c JOIN players p ON p.steamid = c.steamid WHERE c.ts >= ? AND p.found = 1'),
      // Name, avatar and privacy only for players Steam actually returned.
      status: db.prepare(
        'SELECT (SELECT MAX(ts) FROM checks WHERE steamid = ?1 AND ts >= ?2) AS lastTs, ' +
        '(SELECT COUNT(*) FROM checks WHERE steamid = ?1 AND ts >= ?2) AS count, ' +
        'p.name AS name, p.avatar_hash AS avatarHash, p.private AS private ' +
        'FROM (SELECT 1) LEFT JOIN players p ON p.steamid = ?1 AND p.found = 1'
      ),
      seen: db.prepare('SELECT MAX(ts) AS lastTs, COUNT(*) AS count FROM checks WHERE steamid = ? AND ts >= ?'),
      purgeChecks: db.prepare('DELETE FROM checks WHERE ts < ?'),
      purgePlayers: db.prepare('DELETE FROM players WHERE fetched_at < ? AND steamid NOT IN (SELECT steamid FROM checks)'),
      purgeKv: db.prepare('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?')
    };
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  addCheck(steamId64, ts = this.clock()) {
    this.tx(() => {
      this.s.insertCheck.run(steamId64, ts);
      this.s.upsertPending.run(steamId64, ts, ts);
    });
  }

  takePending(limit) {
    return this.s.takePending.all(limit).map(r => r.steamid);
  }

  pendingCount() {
    return this.s.pendingCount.get().n;
  }

  getPlayer(steamId64) {
    const row = this.s.getPlayer.get(steamId64);
    return row ? { ...row } : null;
  }

  freshPlayerIds(ids, maxAgeMs) {
    const cutoff = this.clock() - maxAgeMs;
    return new Set(ids.filter(id => {
      const p = this.getPlayer(id);
      return p && p.fetchedAt >= cutoff;
    }));
  }

  completePending(ids, players) {
    this.tx(() => {
      for (const p of players) this.s.upsertPlayer.run(p.steamid, p.name, p.avatarHash, p.found, p.private, p.fetchedAt);
      for (const id of ids) this.s.deletePending.run(id);
    });
  }

  recent(sinceTs, limit) {
    return this.s.recent.all(sinceTs, limit).map(r => ({ ...r, private: r.private === 1 }));
  }

  hourCount(sinceTs) {
    return this.s.hourCount.get(sinceTs).n;
  }

  seen(steamId64, sinceTs) {
    const r = this.s.seen.get(steamId64, sinceTs);
    return r && r.count > 0 ? { lastTs: r.lastTs, count: r.count } : null;
  }

  checkStatus(steamIds, sinceTs) {
    return steamIds.map(id => {
      const r = this.s.status.get(id, sinceTs);
      return {
        steamId64: id, lastTs: r.lastTs ?? null, count: r.count,
        name: r.name ?? null, avatarHash: r.avatarHash ?? null, private: r.private === 1
      };
    });
  }

  purge(now = this.clock()) {
    this.tx(() => {
      this.s.purgeChecks.run(now - DAY_MS);
      this.s.purgePlayers.run(now - 7 * DAY_MS);
      this.s.purgeKv.run(now);
    });
  }
}
