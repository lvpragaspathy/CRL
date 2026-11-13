// Derived stats for the Stats and Lab tabs. Pure functions over the league data + computeLeague output.
import { seasonKey, seasonStart, nextSeasonKey, backtest, prepareLeague, DEFAULT_PARAMS, ownDeck } from './rating.js';

export const CLOSE_HP = 1500;          // a 1-crown game is "close" if the winner's HP edge was at most this
export const SESSION_GAP_MIN = 45;     // a gap longer than this starts a new session
const DAY = 864e5;
const score = o => (o.n ? (o.w + 0.5 * o.d) / o.n : null);
const blank = () => ({ n: 0, w: 0, l: 0, d: 0 });
const resultFor = (m, side) => (m.winner === 'draw' ? 'd' : m.winner === side ? 'w' : 'l');

/* ---------- tower HP ---------- */
// Destroyed towers are missing from the log. If the other side took 3 crowns everything is down.
function sideHp(side, crownsAgainst) {
  if (crownsAgainst >= 3) return 0;
  if (!side || side.king == null) return null; // king still standing but no data: unknown
  return side.king + (side.princess || []).reduce((a, b) => a + b, 0);
}
/** Remaining tower HP for each side, the winner's HP edge, and whether the game was close. */
export function hpInfo(m) {
  if (!m.stats) return null;
  const hpA = sideHp(m.stats.a, m.cb), hpB = sideHp(m.stats.b, m.ca);
  if (hpA == null || hpB == null) return null;
  const diff = Math.abs(m.ca - m.cb);
  const margin = m.winner === 'b' ? hpB - hpA : hpA - hpB;
  const close = m.winner === 'draw' || diff === 0 || (diff === 1 && margin <= CLOSE_HP);
  return { hpA, hpB, margin, close };
}

/** Per player: record in close games and average HP edge (own towers left minus opponent's). */
export function clutch(data, view) {
  const rows = {};
  for (const m of view.ms) {
    const h = hpInfo(m); if (!h) continue;
    for (const side of ['a', 'b']) {
      const id = m[side]; if (!data.players[id]) continue;
      const r = rows[id] || (rows[id] = { id, n: 0, marginSum: 0, close: blank() });
      r.n++; r.marginSum += side === 'a' ? h.hpA - h.hpB : h.hpB - h.hpA;
      if (h.close) { r.close.n++; r.close[resultFor(m, side)]++; }
    }
  }
  return Object.values(rows).map(r => ({ ...r, avgMargin: r.marginSum / r.n, closeRate: score(r.close) }))
    .sort((a, b) => (b.closeRate ?? -1) - (a.closeRate ?? -1) || b.close.n - a.close.n);
}

/* ---------- elixir leaked ---------- */
export function leaks(data, view) {
  const rows = {};
  for (const m of view.ms) {
    if (!m.stats) continue;
    for (const side of ['a', 'b']) {
      const v = m.stats[side]?.leaked, id = m[side];
      if (!Number.isFinite(v) || !data.players[id]) continue;
      const r = rows[id] || (rows[id] = { id, n: 0, sum: 0, win: { n: 0, sum: 0 }, loss: { n: 0, sum: 0 }, max: null });
      r.n++; r.sum += v;
      const res = resultFor(m, side);
      if (res === 'w') { r.win.n++; r.win.sum += v; } else if (res === 'l') { r.loss.n++; r.loss.sum += v; }
      if (!r.max || v > r.max.v) r.max = { v, matchId: m.id };
    }
  }
  return Object.values(rows).map(r => ({
    ...r, avg: r.sum / r.n,
    avgWin: r.win.n ? r.win.sum / r.win.n : null,
    avgLoss: r.loss.n ? r.loss.sum / r.loss.n : null,
  })).sort((a, b) => a.avg - b.avg);
}

/* ---------- tilt ---------- */
/** Win rate after a win vs after a loss, and in the first game of a session vs later ones. */
export function tilt(data, view) {
  const rows = {}, last = {};
  for (const m of view.ms) {
    for (const side of ['a', 'b']) {
      const id = m[side]; if (!data.players[id]) continue;
      const r = rows[id] || (rows[id] = { id, afterW: blank(), afterL: blank(), first: blank(), later: blank() });
      const res = resultFor(m, side), prev = last[id];
      const newSession = !prev || m.playedAt - prev.t > SESSION_GAP_MIN * 60000;
      const bump = o => { o.n++; o[res]++; };
      if (prev?.res === 'w') bump(r.afterW);
      if (prev?.res === 'l') bump(r.afterL);
      bump(newSession ? r.first : r.later);
      last[id] = { t: m.playedAt, res };
    }
  }
  return Object.values(rows).map(r => ({
    ...r, afterWRate: score(r.afterW), afterLRate: score(r.afterL), firstRate: score(r.first), laterRate: score(r.later),
  }));
}

/* ---------- when people play ---------- */
const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const hmFmt = new Map();
export function heatmap(view, tz) {
  if (!hmFmt.has(tz)) hmFmt.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }));
  const f = hmFmt.get(tz);
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const m of view.ms) {
    const p = {}; for (const x of f.formatToParts(new Date(m.playedAt))) p[x.type] = x.value;
    const d = WD[p.weekday], h = +p.hour % 24;
    if (d != null && Number.isFinite(h)) grid[d][h]++;
  }
  const max = Math.max(0, ...grid.flat());
  return { grid, max, total: view.ms.length };
}

/* ---------- league meta ---------- */
// Win conditions in priority order; a deck is named by the first one or two it contains.
export const WINCONS = ['Golem', 'Elixir Golem', 'Lava Hound', 'Electro Giant', 'Goblin Giant', 'Giant', 'Royal Giant', 'P.E.K.K.A',
  'Mega Knight', 'Hog Rider', 'Royal Hogs', 'Ram Rider', 'Battle Ram', 'X-Bow', 'Mortar', 'Graveyard', 'Goblin Barrel',
  'Skeleton Barrel', 'Balloon', 'Miner', 'Goblin Drill', 'Wall Breakers', 'Three Musketeers', 'Sparky', 'Royal Recruits', 'Giant Skeleton'];
export function archetype(deck) {
  const names = new Set((deck?.cards || []).map(c => c.name));
  const found = WINCONS.filter(w => names.has(w)).slice(0, 2);
  return found.length ? found.join(' + ') : 'Control';
}
export function meta(data, view) {
  const cards = new Map(), arch = new Map();
  let decks = 0;
  // Mirror and draft decks aren't anyone's choice, so the meta only counts bring-your-own-deck battles.
  const ms = view.ms.filter(ownDeck);
  for (const m of ms) {
    for (const side of ['a', 'b']) {
      const deck = side === 'a' ? m.deckA : m.deckB, id = m[side];
      if (!deck?.cards?.length) continue;
      decks++;
      const res = resultFor(m, side);
      for (const c of deck.cards) {
        const k = String(c.id);
        const o = cards.get(k) || { card: c, ...blank() }; o.n++; o[res]++; cards.set(k, o);
      }
      const name = archetype(deck);
      const a = arch.get(name) || { name, ...blank(), players: {}, sample: deck };
      a.n++; a[res]++; a.players[id] = (a.players[id] || 0) + 1; arch.set(name, a);
    }
  }
  const list = map => [...map.values()].map(o => ({ ...o, rate: score(o), usage: decks ? o.n / decks : 0 }));
  return {
    decks, battles: ms.length, skipped: view.ms.length - ms.length,
    cards: list(cards).sort((a, b) => b.n - a.n || b.rate - a.rate),
    archetypes: list(arch).sort((a, b) => b.n - a.n || b.rate - a.rate)
      .map(a => ({ ...a, mains: Object.entries(a.players).sort((x, y) => y[1] - x[1]).map(([pid, n]) => ({ pid, n })) })),
  };
}

/* ---------- season race ---------- */
/** RP lines for everyone who played in a season (or all time), each starting at the season's opening RP. */
export function race(data, L, key, tz) {
  const isAll = key === 'all';
  const start = isAll ? (L.all.ms[0]?.playedAt ?? Date.now()) : seasonStart(key, tz);
  const end = isAll ? Date.now() : Math.min(Date.now(), seasonStart(nextSeasonKey(key), tz));
  const rp = e => e.r - 2 * e.rd;
  const series = [];
  for (const id in L.timeline) {
    const p = data.players[id]; if (!p || p.archived) continue;
    const tl = L.timeline[id];
    const games = tl.filter(e => !e.reset && (isAll || e.season === key));
    if (!games.length) continue;
    let pts;
    if (isAll) pts = [{ t: start, r: 1500 - 2 * 350 }, ...tl.map(e => ({ t: e.t ?? seasonStart(e.season, tz), r: rp(e) }))];
    else {
      const reset = tl.find(e => e.reset && e.season === key);
      pts = [{ t: start, r: reset ? rp(reset) : 1500 - 2 * 350 }, ...games.map(e => ({ t: e.t, r: rp(e) }))];
    }
    pts.push({ t: end, r: pts[pts.length - 1].r });
    series.push({ id, pts, last: pts[pts.length - 1].r });
  }
  return { start, end, series: series.sort((a, b) => b.last - a.last) };
}

/* ---------- record book ---------- */
function allDeltas(L) {
  const d = {}; for (const k in L.byKey) Object.assign(d, L.byKey[k].delta); return d;
}
export function records(data, L, tz) {
  const ms = L.all.ms, deltas = allDeltas(L), P = data.players, out = [];
  // One formatter for the whole pass: building an Intl formatter per match was the slowest thing on the Stats page.
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayKey = t => dayFmt.format(new Date(t));
  const add = (o) => { if (o) out.push(o); };

  // Longest win streak, all time
  const cur = {}; let best = null;
  for (const m of ms) for (const side of ['a', 'b']) {
    const id = m[side], res = resultFor(m, side);
    if (res === 'w') {
      const c = cur[id] && cur[id].n ? cur[id] : (cur[id] = { n: 0, from: m.playedAt });
      c.n++; c.to = m.playedAt;
      if (!best || c.n > best.n) best = { id, ...c };
    } else cur[id] = { n: 0 };
  }
  if (best && best.n >= 2) add({ key: 'streak', title: 'Longest win streak', value: `${best.n} wins`, who: [best.id], when: best.to });

  // Biggest upset
  let up = null;
  for (const m of ms) {
    const dl = deltas[m.id]; if (!m.ranked || !dl || m.winner === 'draw') continue;
    const p = m.winner === 'a' ? dl.pA : 1 - dl.pA;
    if (!up || p < up.p) up = { p, m };
  }
  if (up && up.p < 0.5) {
    const w = up.m.winner === 'a' ? up.m.a : up.m.b, l = up.m.winner === 'a' ? up.m.b : up.m.a;
    add({ key: 'upset', title: 'Biggest upset', value: `${Math.round(up.p * 100)}% chance`, who: [w], vs: l, when: up.m.playedAt, matchId: up.m.id });
  }

  // Biggest single-game RP gain. Placement games swing hard by design, so they don't count (rpA/rpB are null there).
  let gain = null;
  for (const m of ms) {
    const dl = deltas[m.id]; if (!dl || dl.a == null) continue;
    for (const [side, d] of [['a', dl.rpA], ['b', dl.rpB]]) if (d != null && (!gain || d > gain.d)) gain = { d, id: m[side], m };
  }
  if (gain && gain.d > 0) add({ key: 'gain', title: 'Biggest single-game gain', value: `+${Math.round(gain.d)} RP`, who: [gain.id], vs: gain.m.a === gain.id ? gain.m.b : gain.m.a, when: gain.m.playedAt, matchId: gain.m.id });

  // Best day (net RP) and busiest day (battles)
  const days = {};
  for (const m of ms) {
    const dl = deltas[m.id], k = dayKey(m.playedAt);
    for (const side of ['a', 'b']) {
      const o = days[m[side] + '|' + k] || (days[m[side] + '|' + k] = { id: m[side], day: k, net: 0, n: 0, t: m.playedAt });
      o.n++; const rd = dl && (side === 'a' ? dl.rpA : dl.rpB); if (rd != null) o.net += rd;
    }
  }
  const dl = Object.values(days);
  const bestDay = dl.slice().sort((a, b) => b.net - a.net)[0];
  if (bestDay && bestDay.net > 0) add({ key: 'day', title: 'Best single day', value: `+${Math.round(bestDay.net)} RP in ${bestDay.n} battle${bestDay.n === 1 ? '' : 's'}`, who: [bestDay.id], when: bestDay.t });
  const busy = dl.slice().sort((a, b) => b.n - a.n)[0];
  if (busy && busy.n >= 3) add({ key: 'busy', title: 'Most battles in a day', value: `${busy.n} battles`, who: [busy.id], when: busy.t });

  // Most 3-crown wins in a season
  const threes = {};
  for (const m of ms) {
    if (m.winner === 'draw') continue;
    const side = m.winner, crowns = side === 'a' ? m.ca : m.cb;
    if (crowns !== 3) continue;
    const k = m[side] + '|' + seasonKey(m.playedAt, tz);
    threes[k] = (threes[k] || 0) + 1;
  }
  const t3 = Object.entries(threes).sort((a, b) => b[1] - a[1])[0];
  if (t3) { const [id, sk] = t3[0].split('|'); add({ key: 'three', title: 'Most 3-crowns in a season', value: `${t3[1]} three-crowns`, who: [id], season: sk }); }

  // Biggest blowout by tower HP, and the leakiest game
  let blow = null, leak = null;
  for (const m of ms) {
    const h = hpInfo(m);
    if (h && m.winner !== 'draw' && (!blow || h.margin > blow.h.margin)) blow = { h, m };
    for (const side of ['a', 'b']) {
      const v = m.stats?.[side]?.leaked;
      if (Number.isFinite(v) && (!leak || v > leak.v)) leak = { v, id: m[side], m };
    }
  }
  if (blow) add({ key: 'blowout', title: 'Biggest blowout', value: `${Math.round(blow.h.margin).toLocaleString()} HP ahead`, who: [blow.m.winner === 'a' ? blow.m.a : blow.m.b], vs: blow.m.winner === 'a' ? blow.m.b : blow.m.a, when: blow.m.playedAt, matchId: blow.m.id });
  if (leak && leak.v > 0) add({ key: 'leak', title: 'Most elixir leaked in a game', value: `${leak.v.toFixed(1)} elixir`, who: [leak.id], when: leak.m.playedAt, matchId: leak.m.id, shame: true });

  return out.filter(r => r.who.every(id => P[id]));
}

/* ---------- weekly recap ---------- */
export function weekly(data, L, now = Date.now()) {
  const from = now - 7 * DAY, deltas = allDeltas(L);
  const ms = L.all.ms.filter(m => m.playedAt >= from && m.playedAt <= now);
  const per = {};
  let threes = 0, upset = null;
  for (const m of ms) {
    const dl = deltas[m.id];
    if (m.winner !== 'draw' && Math.max(m.ca, m.cb) === 3) threes++;
    for (const side of ['a', 'b']) {
      const id = m[side], res = resultFor(m, side);
      const o = per[id] || (per[id] = { id, ...blank(), net: 0 });
      o.n++; o[res]++; const rd = dl && (side === 'a' ? dl.rpA : dl.rpB); if (rd != null) o.net += rd;
    }
    if (dl && m.ranked && m.winner !== 'draw') {
      const p = m.winner === 'a' ? dl.pA : 1 - dl.pA;
      if (p < 0.5 && (!upset || p < upset.p)) upset = { p, m };
    }
  }
  const rows = Object.values(per).filter(o => data.players[o.id]);
  return {
    from, to: now, battles: ms.length, threes,
    topGainer: rows.slice().sort((a, b) => b.net - a.net)[0] || null,
    mostWins: rows.slice().sort((a, b) => b.w - a.w || b.net - a.net)[0] || null,
    mostActive: rows.slice().sort((a, b) => b.n - a.n)[0] || null,
    upset, rows,
  };
}

/* ---------- Lab: how good are the predictions? ---------- */
const clampP = p => Math.min(1 - 1e-6, Math.max(1e-6, p));
export function scorePreds(preds) {
  if (!preds.length) return { n: 0 };
  let ll = 0, br = 0, hit = 0, decided = 0;
  for (const { p, s } of preds) {
    const q = clampP(p);
    ll += -(s * Math.log(q) + (1 - s) * Math.log(1 - q));
    br += (p - s) ** 2;
    if (s !== 0.5 && p !== 0.5) { decided++; if ((p > 0.5) === (s === 1)) hit++; }
  }
  return { n: preds.length, logLoss: ll / preds.length, brier: br / preds.length, accuracy: decided ? hit / decided : null, decided };
}
/** Bucket predictions from the favorite's side: did 70% favorites win about 70% of the time? */
export function calibration(preds, edges = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0001]) {
  const bins = edges.slice(0, -1).map((lo, i) => ({ lo, hi: Math.min(1, edges[i + 1]), n: 0, pSum: 0, sSum: 0 }));
  for (const { p, s } of preds) {
    const fav = p >= 0.5 ? p : 1 - p, won = p >= 0.5 ? s : 1 - s;
    const b = bins.find(x => fav >= x.lo && fav < (x.hi === 1 ? 1.0001 : x.hi)); if (!b) continue;
    b.n++; b.pSum += fav; b.sSum += won;
  }
  return bins.map(b => ({ ...b, predicted: b.n ? b.pSum / b.n : null, actual: b.n ? b.sSum / b.n : null }));
}
/** Plain Elo (K=24, no margin, no seasons) on the same games, as a baseline. */
export function eloPreds(data, opts) {
  const P = prepareLeague(data, opts), R = {}, out = [];
  for (const m of P.ms) {
    const ra = R[m.a] ?? 1000, rb = R[m.b] ?? 1000;
    const p = 1 / (1 + 10 ** ((rb - ra) / 400));
    if (!m.ranked) continue;
    const s = m.winner === 'a' ? 1 : m.winner === 'b' ? 0 : 0.5;
    out.push({ p, s, t: m.playedAt });
    R[m.a] = ra + 24 * (s - p); R[m.b] = rb + 24 * ((1 - s) - (1 - p));
  }
  return out;
}

export const GRID = { tau: [0.3, 0.5, 0.8, 1.2], carry: [0.25, 0.5, 0.75, 1], rdFloor: [100, 150, 200], marginScale: [0, 0.5, 1, 1.5, 2] };
/**
 * Grid search over the tunable params. Fit on the first 70% of games (chronologically), then report
 * log-loss on the last 30%, which the search never saw, so an overfit "best" shows up as no real gain.
 */
export function tune(data, opts, { split = 0.7, grid = GRID } = {}) {
  const prepared = prepareLeague(data, opts);
  const ranked = prepared.ms.filter(m => m.ranked).length;
  if (ranked < 20) return { tooFew: true, n: ranked };
  const cut = Math.floor(ranked * split);
  const evalParams = params => {
    const preds = backtest(data, params, { ...opts, prepared });
    return { params, train: scorePreds(preds.slice(0, cut)).logLoss, test: scorePreds(preds.slice(cut)).logLoss, all: scorePreds(preds).logLoss };
  };
  const results = [];
  for (const tau of grid.tau) for (const carry of grid.carry) for (const rdFloor of grid.rdFloor) for (const marginScale of grid.marginScale)
    results.push(evalParams({ tau, carry, rdFloor, marginScale }));
  results.sort((a, b) => a.train - b.train);
  const current = evalParams({ ...DEFAULT_PARAMS });
  return { n: ranked, cut, best: results[0], current, tried: results.length, top: results.slice(0, 5) };
}
