// Postgres store. Tables are created on boot, so a fresh Railway Postgres works with no manual setup.
export async function createPgStore(url, { ssl = false } = {}) {
  const { default: pg } = await import('pg');
  // BIGINT columns hold epoch ms; parse them as JS numbers (safe until year 287396).
  pg.types.setTypeParser(20, v => Number(v));
  const pool = new pg.Pool({ connectionString: url, ssl: ssl ? { rejectUnauthorized: false } : false, max: 5 });
  const q = (text, params) => pool.query(text, params);

  const toPlayer = r => r && ({
    id: r.id, name: r.name, tag: r.tag, color: r.color, deck: r.deck, archived: r.archived, createdAt: r.created_at,
  });
  const toMatch = r => r && ({
    id: r.id, a: r.a, b: r.b, ca: r.ca, cb: r.cb, winner: r.winner, playedAt: r.played_at, createdAt: r.created_at,
    mode: r.mode, notes: r.notes, ranked: r.ranked, source: r.source, battleKey: r.battle_key, tiebreak: r.tiebreak,
  });
  const P_COLS = { name: 'name', tag: 'tag', color: 'color', deck: 'deck', archived: 'archived' };
  const M_COLS = {
    a: 'a', b: 'b', ca: 'ca', cb: 'cb', winner: 'winner', playedAt: 'played_at', mode: 'mode', notes: 'notes',
    ranked: 'ranked', source: 'source', battleKey: 'battle_key', tiebreak: 'tiebreak',
  };
  async function patch(table, cols, id, fields) {
    const keys = Object.keys(fields).filter(k => k in cols);
    if (!keys.length) return (await q(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0];
    const sets = keys.map((k, i) => `${cols[k]} = $${i + 2}`).join(', ');
    const extra = table === 'matches' ? ' AND NOT deleted' : '';
    return (await q(`UPDATE ${table} SET ${sets} WHERE id = $1${extra} RETURNING *`, [id, ...keys.map(k => fields[k])])).rows[0];
  }

  return {
    kind: 'postgres',
    async init() {
      await q(`
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS players (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          tag TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT '#4a90ff',
          deck TEXT NOT NULL DEFAULT '',
          archived BOOLEAN NOT NULL DEFAULT FALSE,
          created_at BIGINT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS players_tag_unique ON players (tag) WHERE tag <> '';
        CREATE TABLE IF NOT EXISTS matches (
          id TEXT PRIMARY KEY,
          a TEXT NOT NULL,
          b TEXT NOT NULL,
          ca SMALLINT NOT NULL CHECK (ca BETWEEN 0 AND 3),
          cb SMALLINT NOT NULL CHECK (cb BETWEEN 0 AND 3),
          winner TEXT NOT NULL CHECK (winner IN ('a','b','draw')),
          played_at BIGINT NOT NULL,
          created_at BIGINT NOT NULL,
          mode TEXT NOT NULL DEFAULT 'Classic',
          notes TEXT NOT NULL DEFAULT '',
          ranked BOOLEAN NOT NULL DEFAULT TRUE,
          source TEXT NOT NULL DEFAULT 'manual',
          battle_key TEXT UNIQUE,
          tiebreak BOOLEAN NOT NULL DEFAULT FALSE,
          deleted BOOLEAN NOT NULL DEFAULT FALSE
        );
        CREATE INDEX IF NOT EXISTS matches_pair_time ON matches (a, b, played_at);
      `);
    },
    async close() { await pool.end(); },

    async getLeague() {
      const r = (await q(`SELECT value FROM settings WHERE key = 'league_name'`)).rows[0];
      return { name: r ? r.value : 'Friendly Battle League' };
    },
    async setLeague({ name }) {
      await q(`INSERT INTO settings (key, value) VALUES ('league_name', $1)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [name]);
      return { name };
    },

    async listPlayers() { return (await q(`SELECT * FROM players ORDER BY created_at`)).rows.map(toPlayer); },
    async getPlayer(id) { return toPlayer((await q(`SELECT * FROM players WHERE id = $1`, [id])).rows[0]) || null; },
    async insertPlayer(p) {
      const r = await q(`INSERT INTO players (id, name, tag, color, deck, archived, created_at)
                         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [p.id, p.name, p.tag, p.color, p.deck, p.archived, p.createdAt]);
      return toPlayer(r.rows[0]);
    },
    async updatePlayer(id, fields) { return toPlayer(await patch('players', P_COLS, id, fields)) || null; },
    async deletePlayer(id) {
      await q(`DELETE FROM matches WHERE deleted AND (a = $1 OR b = $1)`, [id]);
      await q(`DELETE FROM players WHERE id = $1`, [id]);
    },
    async tagTaken(tag, exceptId) {
      if (!tag) return false;
      return (await q(`SELECT 1 FROM players WHERE tag = $1 AND id <> $2`, [tag, exceptId || ''])).rowCount > 0;
    },
    async countLiveMatchesFor(id) {
      return Number((await q(`SELECT COUNT(*) AS n FROM matches WHERE NOT deleted AND (a = $1 OR b = $1)`, [id])).rows[0].n);
    },

    async listMatches() { return (await q(`SELECT * FROM matches WHERE NOT deleted ORDER BY played_at, created_at`)).rows.map(toMatch); },
    async getMatch(id) { return toMatch((await q(`SELECT * FROM matches WHERE id = $1 AND NOT deleted`, [id])).rows[0]) || null; },
    async insertMatch(m) {
      const r = await q(`INSERT INTO matches (id, a, b, ca, cb, winner, played_at, created_at, mode, notes, ranked, source, battle_key, tiebreak)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                         ON CONFLICT DO NOTHING`,
        [m.id, m.a, m.b, m.ca, m.cb, m.winner, m.playedAt, m.createdAt, m.mode, m.notes, m.ranked,
          m.source || 'manual', m.battleKey || null, !!m.tiebreak]);
      return r.rowCount === 1;
    },
    async updateMatch(id, fields) { return toMatch(await patch('matches', M_COLS, id, fields)) || null; },
    async deleteMatch(id) {
      // Imported battles become tombstones so the poller won't bring them back.
      await q(`UPDATE matches SET deleted = TRUE WHERE id = $1 AND battle_key IS NOT NULL`, [id]);
      await q(`DELETE FROM matches WHERE id = $1 AND battle_key IS NULL`, [id]);
    },
    async findMatchByKey(key) { return toMatch((await q(`SELECT * FROM matches WHERE battle_key = $1`, [key])).rows[0]) || null; },
    async findLinkCandidates(a, b, t, windowMs) {
      const r = await q(`SELECT * FROM matches
                         WHERE NOT deleted AND battle_key IS NULL
                           AND ((a = $1 AND b = $2) OR (a = $2 AND b = $1))
                           AND played_at BETWEEN $3 AND $4`, [a, b, t - windowMs, t + windowMs]);
      return r.rows.map(toMatch);
    },
  };
}
