// Postgres store. Tables are created on boot, so a fresh Railway Postgres works with no manual setup.
export async function createPgStore(url, { ssl = false } = {}) {
  const { default: pg } = await import('pg');
  // BIGINT columns hold epoch ms; parse them as JS numbers (safe until year 287396).
  pg.types.setTypeParser(20, v => Number(v));
  const pool = new pg.Pool({ connectionString: url, ssl: ssl ? { rejectUnauthorized: false } : false, max: 5 });
  const q = (text, params) => pool.query(text, params);

  const toPlayer = r => r && ({
    id: r.id, name: r.name, tag: r.tag, color: r.color, deck: r.deck, archived: r.archived, createdAt: r.created_at, ladder: r.ladder || null,
  });
  const toMatch = r => r && ({
    id: r.id, a: r.a, b: r.b, ca: r.ca, cb: r.cb, winner: r.winner, playedAt: r.played_at, createdAt: r.created_at,
    mode: r.mode, notes: r.notes, ranked: r.ranked, source: r.source, battleKey: r.battle_key, tiebreak: r.tiebreak,
    deckA: r.deck_a || null, deckB: r.deck_b || null, stats: r.stats || null, deleted: r.deleted,
  });
  const P_COLS = { name: 'name', tag: 'tag', color: 'color', deck: 'deck', archived: 'archived', ladder: 'ladder' };
  const M_COLS = {
    a: 'a', b: 'b', ca: 'ca', cb: 'cb', winner: 'winner', playedAt: 'played_at', mode: 'mode', notes: 'notes',
    ranked: 'ranked', source: 'source', battleKey: 'battle_key', tiebreak: 'tiebreak',
    deckA: 'deck_a', deckB: 'deck_b', stats: 'stats',
  };
  // Stringify decks ourselves: node-postgres would turn a top-level array into a Postgres array, not JSON.
  const jsonOrNull = v => (v == null ? null : JSON.stringify(v));
  async function patch(table, cols, id, fields) {
    const keys = Object.keys(fields).filter(k => k in cols);
    if (!keys.length) return (await q(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0];
    const sets = keys.map((k, i) => `${cols[k]} = $${i + 2}`).join(', ');
    const extra = table === 'matches' ? ' AND NOT deleted' : '';
    const vals = keys.map(k => (['deckA', 'deckB', 'stats', 'ladder'].includes(k) ? jsonOrNull(fields[k]) : fields[k]));
    return (await q(`UPDATE ${table} SET ${sets} WHERE id = $1${extra} RETURNING *`, [id, ...vals])).rows[0];
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
        ALTER TABLE matches ADD COLUMN IF NOT EXISTS deck_a JSONB;
        ALTER TABLE matches ADD COLUMN IF NOT EXISTS deck_b JSONB;
        ALTER TABLE matches ADD COLUMN IF NOT EXISTS stats JSONB;
        ALTER TABLE players ADD COLUMN IF NOT EXISTS ladder JSONB;
        CREATE TABLE IF NOT EXISTS battles_raw (
          battle_key TEXT PRIMARY KEY,
          played_at BIGINT NOT NULL,
          fetched_at BIGINT NOT NULL,
          data JSONB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cards (
          id BIGINT PRIMARY KEY,
          name TEXT NOT NULL,
          elixir SMALLINT,
          rarity TEXT NOT NULL DEFAULT '',
          icon TEXT NOT NULL DEFAULT '',
          icon_evo TEXT NOT NULL DEFAULT ''
        );
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
      const r = await q(`INSERT INTO matches (id, a, b, ca, cb, winner, played_at, created_at, mode, notes, ranked, source, battle_key, tiebreak, deck_a, deck_b, stats)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
                         ON CONFLICT DO NOTHING`,
        [m.id, m.a, m.b, m.ca, m.cb, m.winner, m.playedAt, m.createdAt, m.mode, m.notes, m.ranked,
          m.source || 'manual', m.battleKey || null, !!m.tiebreak, jsonOrNull(m.deckA), jsonOrNull(m.deckB), jsonOrNull(m.stats)]);
      return r.rowCount === 1;
    },
    async updateMatch(id, fields) { return toMatch(await patch('matches', M_COLS, id, fields)) || null; },
    async deleteMatch(id) {
      // Imported battles become tombstones so the poller won't bring them back.
      await q(`UPDATE matches SET deleted = TRUE WHERE id = $1 AND battle_key IS NOT NULL`, [id]);
      await q(`DELETE FROM matches WHERE id = $1 AND battle_key IS NULL`, [id]);
    },
    async upsertCards(list) {
      for (const c of list) {
        await q(`INSERT INTO cards (id, name, elixir, rarity, icon, icon_evo) VALUES ($1,$2,$3,$4,$5,$6)
                 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, elixir = COALESCE(EXCLUDED.elixir, cards.elixir),
                   rarity = EXCLUDED.rarity, icon = COALESCE(NULLIF(EXCLUDED.icon, ''), cards.icon),
                   icon_evo = COALESCE(NULLIF(EXCLUDED.icon_evo, ''), cards.icon_evo)`,
          [c.id, c.name, c.elixir, c.rarity, c.icon, c.iconEvo]);
      }
    },
    async saveRaw(key, data, playedAt) {
      await q(`INSERT INTO battles_raw (battle_key, played_at, fetched_at, data) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [key, playedAt, Date.now(), JSON.stringify(data)]);
    },
    async countRaw() { return Number((await q(`SELECT COUNT(*) AS n FROM battles_raw`)).rows[0].n); },
    async listCards() {
      return (await q(`SELECT * FROM cards`)).rows.map(r => ({ id: r.id, name: r.name, elixir: r.elixir, rarity: r.rarity, icon: r.icon, iconEvo: r.icon_evo }));
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
