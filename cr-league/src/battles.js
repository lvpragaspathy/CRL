// Pure helpers for turning Clash Royale battle log entries into league matches.

const TAG_CHARS = '0289CGJLPQRUVY';
const TAG_RE = new RegExp(`^#[${TAG_CHARS}]{3,14}$`);

/** Uppercase, strip spaces, add '#', and map the letter O to zero (CR tags never contain O). */
export function normTag(raw) {
  if (typeof raw !== 'string') return '';
  let t = raw.trim().toUpperCase().replace(/\s+/g, '').replace(/O/g, '0');
  if (!t) return '';
  if (!t.startsWith('#')) t = '#' + t;
  return t;
}
export const isValidTag = t => TAG_RE.test(t);

/** "20261112T221530.000Z" -> epoch ms (null if unparseable). */
export function parseBattleTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?Z$/.exec(String(s || ''));
  if (!m) return null;
  const [, y, mo, d, h, mi, se, ms] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +se, ms ? +ms.padEnd(3, '0') : 0);
}

/** Same battle appears in both players' logs: key it by time + both tags, order-independent. */
export const battleKey = (time, tagA, tagB) => `${time}|${[tagA, tagB].sort().join('|')}`;

/** Lowest remaining tower HP on one side, or null if the log doesn't include HP. */
export function minTowerHp(side) {
  const hps = [side?.kingTowerHitPoints, ...(Array.isArray(side?.princessTowersHitPoints) ? side.princessTowersHitPoints : [])]
    .filter(n => Number.isFinite(n));
  return hps.length ? Math.min(...hps) : null;
}

/** "TripleElixir_Friendly" -> "Triple Elixir Friendly" */
export function prettyMode(name) {
  if (typeof name !== 'string' || !name) return 'Classic';
  const s = name.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  return s.slice(0, 40) || 'Classic';
}

/**
 * Convert one battle log entry into a league match, or null if it isn't a 1v1 friendly
 * between two league members. Sides are ordered by tag so both players' logs agree.
 */
export function battleToMatch(battle, leagueTags, { types, inferTiebreak = true } = {}) {
  if (!battle || typeof battle !== 'object') return null;
  if (types && !types.includes(battle.type)) return null;
  const team = battle.team, opp = battle.opponent;
  if (!Array.isArray(team) || !Array.isArray(opp) || team.length !== 1 || opp.length !== 1) return null;
  const t1 = normTag(team[0].tag), t2 = normTag(opp[0].tag);
  if (!t1 || !t2 || t1 === t2 || !leagueTags.has(t1) || !leagueTags.has(t2)) return null;
  const playedAt = parseBattleTime(battle.battleTime);
  if (playedAt == null) return null;

  const [A, B] = t1 < t2 ? [team[0], opp[0]] : [opp[0], team[0]];
  const aTag = normTag(A.tag), bTag = normTag(B.tag);
  const ca = clampCrowns(A.crowns), cb = clampCrowns(B.crowns);

  let winner = ca > cb ? 'a' : cb > ca ? 'b' : 'draw';
  let tiebreak = false;
  if (winner === 'draw' && inferTiebreak) {
    const ha = minTowerHp(A), hb = minTowerHp(B);
    if (ha != null && hb != null && ha !== hb) { winner = ha > hb ? 'a' : 'b'; tiebreak = true; }
  }
  const da = extractDeck(A), db = extractDeck(B);
  const sa = sideStats(A), sb = sideStats(B);
  return {
    battleKey: battleKey(battle.battleTime, aTag, bTag),
    aTag, bTag, ca, cb, winner, tiebreak, playedAt,
    mode: prettyMode(battle.gameMode?.name),
    deckA: da?.deck || null,
    deckB: db?.deck || null,
    cards: [...(da?.catalog || []), ...(db?.catalog || [])],
    stats: sa || sb ? { a: sa || emptySide(), b: sb || emptySide() } : null,
    raw: battle,
  };
}

/* ---------- per-side numbers: elixir leaked and tower HP left ----------
 * A destroyed tower is simply missing from the log, so a side with no HP fields at all may have
 * been three-crowned; the client works that out from the crowns. */
const emptySide = () => ({ leaked: null, king: null, princess: [] });
export function sideStats(side) {
  if (!side) return null;
  const leaked = Number.isFinite(side.elixirLeaked) ? Math.round(side.elixirLeaked * 100) / 100 : null;
  const king = Number.isFinite(side.kingTowerHitPoints) ? side.kingTowerHitPoints : null;
  const princess = Array.isArray(side.princessTowersHitPoints) ? side.princessTowersHitPoints.filter(Number.isFinite) : [];
  if (leaked == null && king == null && !princess.length && !('princessTowersHitPoints' in side)) return null;
  return { leaked, king, princess };
}

/* ---------- decks ----------
 * Matches store a compact deck ({cards: [{id, evo}], tower: id}); names, elixir and icon URLs live in a
 * separate card catalog so the league payload stays small. */
const ICON_RE = /^https:\/\/api-assets\.clashroyale\.com\/[\w\-./%]+$/;
const safeIcon = u => (typeof u === 'string' && ICON_RE.test(u) ? u : '');

export function cardInfo(c) {
  const icons = c.iconUrls || {};
  return {
    id: Number(c.id) || 0,
    name: typeof c.name === 'string' ? c.name.slice(0, 40) : 'Unknown card',
    elixir: Number.isFinite(c.elixirCost) ? c.elixirCost : null,
    rarity: typeof c.rarity === 'string' ? c.rarity.slice(0, 12) : '',
    icon: safeIcon(icons.medium),
    iconEvo: safeIcon(icons.evolutionMedium),
  };
}

/** One side's deck from a battle log entry, or null if the log has no cards for it. */
export function extractDeck(side) {
  const raw = Array.isArray(side?.cards) ? side.cards.filter(c => c && Number(c.id)).slice(0, 8) : [];
  if (!raw.length) return null;
  const towerRaw = Array.isArray(side.supportCards) ? side.supportCards.find(c => c && Number(c.id)) : null;
  return {
    deck: {
      cards: raw.map(c => ({ id: Number(c.id), evo: Number(c.evolutionLevel) > 0 })),
      tower: towerRaw ? Number(towerRaw.id) : null,
    },
    catalog: [...raw, ...(towerRaw ? [towerRaw] : [])].map(cardInfo),
  };
}

function clampCrowns(n) {
  const v = Math.round(Number(n) || 0);
  return Math.max(0, Math.min(3, v));
}
