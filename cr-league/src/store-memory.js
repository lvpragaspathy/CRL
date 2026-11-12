// In-memory store with the same interface as the Postgres store. Used for local dev and tests.
const clone = o => (o == null ? o : structuredClone(o));

export function createMemoryStore() {
  let league = { name: 'Friendly Battle League' };
  const players = new Map();
  const matches = new Map();
  const cards = new Map();
  const raw = new Map();

  return {
    kind: 'memory',
    async init() {},
    async close() {},

    async getLeague() { return clone(league); },
    async setLeague(l) { league = { ...league, ...l }; return clone(league); },

    async listPlayers() { return [...players.values()].map(clone).sort((a, b) => a.createdAt - b.createdAt); },
    async getPlayer(id) { return clone(players.get(id) || null); },
    async insertPlayer(p) { players.set(p.id, clone(p)); return clone(p); },
    async updatePlayer(id, fields) {
      const p = players.get(id); if (!p) return null;
      Object.assign(p, fields); return clone(p);
    },
    async deletePlayer(id) {
      players.delete(id);
      for (const [mid, m] of matches) if (m.deleted && (m.a === id || m.b === id)) matches.delete(mid);
    },
    async tagTaken(tag, exceptId) { return !!tag && [...players.values()].some(p => p.tag === tag && p.id !== exceptId); },
    async countLiveMatchesFor(id) { return [...matches.values()].filter(m => !m.deleted && (m.a === id || m.b === id)).length; },

    async listMatches() { return [...matches.values()].filter(m => !m.deleted).map(clone).sort((a, b) => a.playedAt - b.playedAt); },
    async getMatch(id) { const m = matches.get(id); return m && !m.deleted ? clone(m) : null; },
    async insertMatch(m) {
      if (m.battleKey && [...matches.values()].some(x => x.battleKey === m.battleKey)) return false;
      if (matches.has(m.id)) return false;
      matches.set(m.id, { deleted: false, ...clone(m) }); return true;
    },
    async updateMatch(id, fields) {
      const m = matches.get(id); if (!m || m.deleted) return null;
      Object.assign(m, clone(fields)); return clone(m);
    },
    async deleteMatch(id) {
      const m = matches.get(id); if (!m) return;
      // Imported battles are kept as tombstones so the poller doesn't re-import them.
      if (m.battleKey) m.deleted = true; else matches.delete(id);
    },
    async upsertCards(list) {
      for (const c of list) {
        const prev = cards.get(c.id);
        cards.set(c.id, { ...c, icon: c.icon || prev?.icon || '', iconEvo: c.iconEvo || prev?.iconEvo || '' });
      }
    },
    async saveRaw(key, data, playedAt) { if (!raw.has(key)) raw.set(key, { data: clone(data), playedAt }); },
    async countRaw() { return raw.size; },
    async listCards() { return [...cards.values()].map(clone); },
    async findMatchByKey(key) { return clone([...matches.values()].find(m => m.battleKey === key) || null); },
    async findLinkCandidates(a, b, t, windowMs) {
      return [...matches.values()].filter(m => !m.deleted && !m.battleKey &&
        ((m.a === a && m.b === b) || (m.a === b && m.b === a)) && Math.abs(m.playedAt - t) <= windowMs).map(clone);
    },
  };
}
