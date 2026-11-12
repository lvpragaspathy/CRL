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
  return {
    battleKey: battleKey(battle.battleTime, aTag, bTag),
    aTag, bTag, ca, cb, winner, tiebreak, playedAt,
    mode: prettyMode(battle.gameMode?.name),
  };
}

function clampCrowns(n) {
  const v = Math.round(Number(n) || 0);
  return Math.max(0, Math.min(3, v));
}
