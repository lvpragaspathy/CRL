// Glicko-2 ratings with monthly seasons.
// Nothing here is stored: every view is rebuilt by replaying matches in time order, so editing or
// deleting an old match corrects everything after it.
//
// Glicko-2 (Glickman, 2012) tracks three numbers per player:
//   r     rating (starts at 1500)
//   RD    rating deviation: how unsure we are about r. High = few or old games. Starts at 350.
//   sigma volatility: how erratic the player's results are.
// Each game is treated as its own rating period. Idle days add uncertainty (RD grows) before the next game.

export const START_R = 1500;
export const START_RD = 350;
export const START_SIGMA = 0.06;
export const TAU = 0.5;               // system constant: how fast volatility can change
export const SCALE = 173.7178;        // Glicko <-> Glicko-2 scale factor
export const PROVISIONAL_RD = 110;    // above this a player is still in placements
export const SEASON_CARRY = 0.5;      // new season: ratings move halfway back to 1500...
export const SEASON_RD_FLOOR = 150;   // ...and RD goes up to at least this (a few placement games)
export const MIN_CHAMP_GAMES = 5;     // games in a season to be eligible for champion
// Rankings use a conservative score: rating minus two RDs, roughly "we're 95% sure you're at least
// this good". A hot start with few games can't top the table until the system is confident in it.
export const SCORE_K = 2;
export const scoreOf = (r, rd) => r - SCORE_K * rd;
// Crown margin. Plain Glicko-2 only sees win/draw/loss, so the rating move (not RD or volatility) is
// scaled by the margin. The bonus is weighted by how surprising the win was, so a heavy favorite
// three-crowning a much weaker player doesn't snowball (same idea as FiveThirtyEight's Elo
// autocorrelation fix).
export const MARGIN_BONUS = { 1: 0, 2: 0.15, 3: 0.3 };

/** The tunable knobs, gathered so the Lab can backtest alternatives. */
export const DEFAULT_PARAMS = Object.freeze({ tau: TAU, carry: SEASON_CARRY, rdFloor: SEASON_RD_FLOOR, marginScale: 1 });
const DAY = 864e5;

/* ---------- Glicko-2 core ---------- */
const g = phi => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expect = (mu, muj, phij) => 1 / (1 + Math.exp(-g(phij) * (mu - muj)));

/** Illinois-method solve for the new volatility (step 5 of Glickman's paper). */
function newVolatility(sigma, phi, v, delta, tau) {
  const a = Math.log(sigma * sigma);
  const f = x => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * Math.pow(phi * phi + v + ex, 2)) - (x - a) / (tau * tau);
  };
  let A = a, B;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else { let k = 1; while (f(a - k * tau) < 0) k++; B = a - k * tau; }
  let fA = f(A), fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
    const C = A + ((A - B) * fA) / (fB - fA), fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else fA /= 2;
    B = C; fB = fC;
  }
  return Math.exp(A / 2);
}

/**
 * Margin multiplier for a decided game. crownDiff = winner's crowns minus loser's (0 for a tiebreaker win),
 * pWin = the winner's chance before the game.
 *   even matchup (50%):  1-crown x1.00, 2-crown x1.15, 3-crown x1.30
 *   underdog win (20%):  3-crown x1.48     heavy favorite (90%): 3-crown x1.06
 */
export function marginMult(crownDiff, pWin, scale = 1) {
  const base = MARGIN_BONUS[Math.min(3, Math.max(1, crownDiff))] || 0;
  const surprise = 2 * (1 - Math.min(1, Math.max(0, pWin)));   // 0..2, 1 for an even game
  return 1 + base * scale * surprise;
}

/**
 * One rating period. p = {r, rd, sigma}; games = [{r, rd, s}] with s = 1 win, 0.5 draw, 0 loss.
 * `mult` scales only the rating move (1 = standard Glicko-2).
 */
export function glicko2Update(p, games, tau = TAU, mult = 1) {
  const mu = (p.r - START_R) / SCALE, phi = p.rd / SCALE;
  if (!games.length) return { r: p.r, rd: Math.min(START_RD, Math.sqrt(phi * phi + p.sigma * p.sigma) * SCALE), sigma: p.sigma };
  let vInv = 0, sum = 0;
  for (const o of games) {
    const muj = (o.r - START_R) / SCALE, phij = o.rd / SCALE;
    const gj = g(phij), e = expect(mu, muj, phij);
    vInv += gj * gj * e * (1 - e);
    sum += gj * (o.s - e);
  }
  const v = 1 / vInv;
  const sigma = newVolatility(p.sigma, phi, v, v * sum, tau);
  const phiStar = Math.sqrt(phi * phi + sigma * sigma);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * sum * mult;
  return { r: muNew * SCALE + START_R, rd: Math.min(START_RD, phiNew * SCALE), sigma };
}

/** RD grows while a player sits idle (one rating period per day). */
export function inflate(p, days) {
  if (!(days > 0)) return p;
  const phi = p.rd / SCALE;
  return { ...p, rd: Math.min(START_RD, Math.sqrt(phi * phi + p.sigma * p.sigma * days) * SCALE) };
}

/** Chance that a beats b, accounting for both players' uncertainty. */
export function winProb(a, b) {
  const phi = Math.sqrt(a.rd * a.rd + b.rd * b.rd) / SCALE;
  return 1 / (1 + Math.exp(-g(phi) * ((a.r - b.r) / SCALE)));
}

/* ---------- seasons (calendar months in the league's time zone) ---------- */
const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) {
    let f;
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch { f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    fmtCache.set(tz, f);
  }
  return fmtCache.get(tz);
}
function parts(ms, tz) {
  const o = {}; for (const p of fmt(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}
export function seasonKey(ms, tz) { const p = parts(ms, tz); return `${p.y}-${String(p.m).padStart(2, '0')}`; }
export function nextSeasonKey(key) { let [y, m] = key.split('-').map(Number); m++; if (m > 12) { m = 1; y++; } return `${y}-${String(m).padStart(2, '0')}`; }
export function seasonLabel(key, short = false) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: short ? 'short' : 'long', year: 'numeric', timeZone: 'UTC' });
}
/** First instant of a season in the league time zone. */
export function seasonStart(key, tz) {
  const [y, m] = key.split('-').map(Number);
  const target = Date.UTC(y, m - 1, 1);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = parts(guess, tz);
    const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(guess / 1000) * 1000;
    guess = target - offset;
  }
  return guess;
}
export function seasonKeysBetween(fromKey, toKey) {
  const out = []; let k = fromKey;
  while (k <= toKey && out.length < 600) { out.push(k); k = nextSeasonKey(k); }
  return out;
}

/* ---------- replay ---------- */
export const byTime = (x, y) => x.playedAt - y.playedAt || (x.createdAt || 0) - (y.createdAt || 0) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

function blankStats(id, r, rd) {
  const sc = scoreOf(r, rd);
  return { id, r, rd, score: sc, lastScore: null, scoreHist: [sc], games: 0, ranked: 0, w: 0, l: 0, d: 0, cf: 0, ca: 0, three: 0, peak: r, hist: [r], rdHist: [rd],
    streakT: '', streakN: 0, best: 0, form: [], last: null, h2h: {} };
}
function tally(s, cf, ca, r, opp, d) {
  s.games++; s.cf += cf; s.ca += ca;
  if (r === 'W') { s.w++; if (cf === 3) s.three++; } else if (r === 'L') s.l++; else s.d++;
  if (r === 'D') { s.streakT = ''; s.streakN = 0; }
  else if (s.streakT === r) s.streakN++;
  else { s.streakT = r; s.streakN = 1; }
  if (s.streakT === 'W') s.best = Math.max(s.best, s.streakN);
  s.form.push(r); if (s.form.length > 5) s.form.shift();
  const h = s.h2h[opp] || (s.h2h[opp] = { n: 0, w: 0, l: 0, d: 0, cf: 0, ca: 0, net: 0 });
  h.n++; h[r === 'W' ? 'w' : r === 'L' ? 'l' : 'd']++; h.cf += cf; h.ca += ca; h.net += d || 0;
}

/**
 * Replays matches. With `seasons`, ratings soft-reset at each month boundary and stats are kept per
 * season; without, one continuous all-time view.
 */
function simulate(players, ms, { keys, keyOf, resets, now, params = DEFAULT_PARAMS }) {
  const state = {};
  for (const id in players) state[id] = { r: START_R, rd: START_RD, sigma: START_SIGMA, lastAt: null, played: false };
  const views = {}, timeline = {};
  for (const id in players) timeline[id] = [];
  let mi = 0;
  keys.forEach((key, ki) => {
    if (ki > 0 && resets) {
      for (const id in state) {
        const s = state[id]; if (!s.played) continue;
        s.r = START_R + (s.r - START_R) * params.carry;
        s.rd = Math.max(s.rd, params.rdFloor);
        timeline[id].push({ t: null, r: s.r, rd: s.rd, season: key, reset: true });
      }
    }
    const st = {}; for (const id in state) st[id] = blankStats(id, state[id].r, state[id].rd);
    const view = { key, st, ms: [], delta: {} };
    while (mi < ms.length && keyOf(ms[mi]) === key) {
      const m = ms[mi++];
      const A = state[m.a], B = state[m.b];
      // Copies: inflate() hands back the same object when no days passed, and A/B get updated below.
      const a0 = { ...inflate(A, A.lastAt == null ? 0 : Math.floor((m.playedAt - A.lastAt) / DAY)) };
      const b0 = { ...inflate(B, B.lastAt == null ? 0 : Math.floor((m.playedAt - B.lastAt) / DAY)) };
      const pA = winProb(a0, b0);
      let dA = null, dB = null, mult = null;
      if (m.ranked) {
        const sa = m.winner === 'a' ? 1 : m.winner === 'b' ? 0 : 0.5;
        mult = m.winner === 'draw' ? 1
          : marginMult(m.winner === 'a' ? m.ca - m.cb : m.cb - m.ca, m.winner === 'a' ? pA : 1 - pA, params.marginScale);
        const a1 = glicko2Update(a0, [{ r: b0.r, rd: b0.rd, s: sa }], params.tau, mult);
        const b1 = glicko2Update(b0, [{ r: a0.r, rd: a0.rd, s: 1 - sa }], params.tau, mult);
        dA = a1.r - a0.r; dB = b1.r - b0.r;
        Object.assign(A, a1, { lastAt: m.playedAt, played: true });
        Object.assign(B, b1, { lastAt: m.playedAt, played: true });
        for (const [id, S, P, pre] of [[m.a, st[m.a], A, a0], [m.b, st[m.b], B, b0]]) {
          S.r = P.r; S.rd = P.rd; S.ranked++; S.peak = Math.max(S.peak, P.r);
          S.hist.push(P.r); S.rdHist.push(P.rd);
          S.score = scoreOf(P.r, P.rd); S.scoreHist.push(S.score);
          S.lastScore = S.score - scoreOf(pre.r, pre.rd);
          timeline[id].push({ t: m.playedAt, r: P.r, rd: P.rd, season: key });
        }
        st[m.a].last = dA; st[m.b].last = dB;
      }
      tally(st[m.a], m.ca, m.cb, m.winner === 'a' ? 'W' : m.winner === 'b' ? 'L' : 'D', m.b, dA);
      tally(st[m.b], m.cb, m.ca, m.winner === 'b' ? 'W' : m.winner === 'a' ? 'L' : 'D', m.a, dB);
      view.delta[m.id] = { a: dA, b: dB, preA: a0.r, preB: b0.r, preRdA: a0.rd, preRdB: b0.rd, pA, mult };
      view.ms.push(m);
    }
    views[key] = view;
  });
  // RD keeps growing while idle, so "now" values for the latest view include time since each last game.
  const lastView = views[keys[keys.length - 1]];
  const current = {};
  for (const id in state) {
    const s = state[id];
    current[id] = inflate(s, s.lastAt == null ? 0 : Math.floor((now - s.lastAt) / DAY));
    // Idle time raises RD, so the score drifts down slowly for players who stop playing.
    if (lastView) { lastView.st[id].rd = current[id].rd; lastView.st[id].score = scoreOf(lastView.st[id].r, current[id].rd); }
  }
  return { views, timeline, current };
}

/**
 * Everything the UI needs. data = {players, matches}; opts = {tz, now}.
 * Returns season views (soft resets), an all-time view, champions and live ratings for predictions.
 */
function prepare(data, tz, now) {
  const players = data.players;
  const ms = Object.values(data.matches).filter(m => players[m.a] && players[m.b] && m.a !== m.b).sort(byTime);
  const nowKey = seasonKey(now, tz);
  const firstKey = ms.length ? seasonKey(ms[0].playedAt, tz) : nowKey;
  const lastKey = ms.length ? [nowKey, seasonKey(ms[ms.length - 1].playedAt, tz)].sort().pop() : nowKey;
  const keys = seasonKeysBetween(firstKey < nowKey ? firstKey : nowKey, lastKey);
  const keyMap = new Map(ms.map(m => [m.id, seasonKey(m.playedAt, tz)]));
  return { players, ms, nowKey, keys, keyOf: m => keyMap.get(m.id) };
}

/**
 * Pre-game predictions for every rated game, in order, under a given set of params:
 * [{ p: chance side A wins, s: actual score for A (1 / 0.5 / 0), t }]
 */
export function backtest(data, params = DEFAULT_PARAMS, { tz = 'America/Chicago', now = Date.now(), prepared } = {}) {
  const P = prepared || prepare(data, tz, now);
  const { views } = simulate(P.players, P.ms, { keys: P.keys, keyOf: P.keyOf, resets: true, now, params });
  const out = [];
  for (const m of P.ms) {
    if (!m.ranked) continue;
    const d = views[P.keyOf(m)].delta[m.id];
    out.push({ p: d.pA, s: m.winner === 'a' ? 1 : m.winner === 'b' ? 0 : 0.5, t: m.playedAt });
  }
  return out;
}
export const prepareLeague = (data, { tz = 'America/Chicago', now = Date.now() } = {}) => prepare(data, tz, now);

export function computeLeague(data, { tz = 'America/Chicago', now = Date.now(), params = DEFAULT_PARAMS } = {}) {
  const { players, ms, nowKey, keys, keyOf } = prepare(data, tz, now);
  const season = simulate(players, ms, { keys, keyOf, resets: true, now, params });
  const all = simulate(players, ms, { keys: ['all'], keyOf: () => 'all', resets: false, now, params }).views.all;

  const champions = [], champCount = {};
  for (const key of keys) {
    if (key >= nowKey) continue;
    const v = season.views[key];
    const best = Object.values(v.st).filter(s => s.games >= MIN_CHAMP_GAMES).sort((a, b) => b.score - a.score)[0];
    if (best) { champions.push({ key, id: best.id, r: best.r, score: best.score, games: best.games }); champCount[best.id] = (champCount[best.id] || 0) + 1; }
  }
  const end = seasonStart(nextSeasonKey(nowKey), tz);
  return {
    seasons: keys.slice().reverse(),   // newest first
    currentKey: nowKey,
    seasonEndsAt: end,
    byKey: season.views,
    all,
    champions: champions.reverse(),
    champCount,
    timeline: season.timeline,
    live: season.current,              // {r, rd, sigma} right now, for win probabilities
  };
}

/* ---------- presentation helpers ---------- */
/** Tiers go by score (rating − 2·RD); anyone the system is still unsure about is in placements. */
export function tier(s) {
  if (!s.games) return { name: 'Unranked', cls: 't-place' };
  if (s.rd > PROVISIONAL_RD) return { name: 'Placement', cls: 't-place' };
  const v = s.score ?? scoreOf(s.r, s.rd);
  if (v >= 1600) return { name: 'Champion', cls: 't-champ' };
  if (v >= 1500) return { name: 'Diamond', cls: 't-diamond' };
  if (v >= 1400) return { name: 'Gold', cls: 't-gold' };
  if (v >= 1300) return { name: 'Silver', cls: 't-silver' };
  return { name: 'Bronze', cls: 't-bronze' };
}
export function ranking(data, view) {
  return Object.values(data.players).filter(p => !p.archived && view.st[p.id]).sort((x, y) => {
    const a = view.st[x.id], b = view.st[y.id];
    return (b.games > 0) - (a.games > 0) || b.score - a.score || b.r - a.r || b.games - a.games || x.name.localeCompare(y.name);
  });
}
export const pct = s => (s.games ? Math.round((100 * (s.w + 0.5 * s.d)) / s.games) + '%' : '—');

/* ---------- deck + card stats ---------- */
export const avgElixir = deck => {
  const xs = (deck?.cards || []).map(c => c.elixir).filter(Number.isFinite);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};
const deckSig = deck => deck.cards.map(c => c.id + (c.evo ? 'e' : '')).sort().join(',');

/** Card usage, deck records and card matchups for one player across a list of matches. */
export function cardStats(pid, matches) {
  const cards = new Map(), decks = new Map(), vs = new Map();
  let games = 0;
  const bump = (map, key, card, res, extra) => {
    const o = map.get(key) || { card, n: 0, w: 0, l: 0, d: 0, ...extra };
    o.n++; o[res]++; map.set(key, o);
  };
  for (const m of matches) {
    const isA = m.a === pid; if (!isA && m.b !== pid) continue;
    const mine = isA ? m.deckA : m.deckB, theirs = isA ? m.deckB : m.deckA;
    if (!mine?.cards?.length) continue;
    games++;
    const res = m.winner === 'draw' ? 'd' : (m.winner === (isA ? 'a' : 'b') ? 'w' : 'l');
    for (const c of mine.cards) bump(cards, c.id + (c.evo ? 'e' : ''), c, res);
    bump(decks, deckSig(mine), null, res, { deck: mine });
    if (theirs?.cards?.length) for (const c of theirs.cards) bump(vs, String(c.id), c, res);
  }
  const rate = o => (o.w + 0.5 * o.d) / o.n;
  const list = map => [...map.values()].map(o => ({ ...o, rate: rate(o) }));
  return {
    games,
    cards: list(cards).sort((a, b) => b.n - a.n || b.rate - a.rate),
    decks: list(decks).sort((a, b) => b.n - a.n || b.rate - a.rate),
    vs: list(vs),
  };
}
