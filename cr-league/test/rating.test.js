import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  glicko2Update, winProb, inflate, marginMult, computeLeague, seasonKey, seasonStart, nextSeasonKey, tier, cardStats,
  START_R, SEASON_CARRY, SEASON_RD_FLOOR, MIN_CHAMP_GAMES,
} from '../public/rating.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ${b}, got ${a}`);

test("matches the worked example in Glickman's Glicko-2 paper", () => {
  const out = glicko2Update({ r: 1500, rd: 200, sigma: 0.06 }, [
    { r: 1400, rd: 30, s: 1 }, { r: 1550, rd: 100, s: 0 }, { r: 1700, rd: 300, s: 0 },
  ]);
  near(out.r, 1464.06, 0.01, 'rating');
  near(out.rd, 151.52, 0.01, 'RD');
  near(out.sigma, 0.05999, 0.00001, 'volatility');
});

test('win probability is symmetric and accounts for uncertainty', () => {
  const a = { r: 1700, rd: 50 }, b = { r: 1500, rd: 50 };
  near(winProb(a, b) + winProb(b, a), 1, 1e-12, 'sums to 1');
  assert.ok(winProb(a, b) > 0.7);
  assert.ok(winProb({ r: 1700, rd: 300 }, { r: 1500, rd: 300 }) < winProb(a, b), 'more uncertainty pulls toward 50%');
  assert.equal(winProb({ r: 1500, rd: 80 }, { r: 1500, rd: 200 }), 0.5);
});

test('idle time grows RD, capped at 350', () => {
  const p = { r: 1600, rd: 60, sigma: 0.06 };
  assert.ok(inflate(p, 30).rd > 60);
  assert.equal(inflate({ ...p, rd: 349 }, 10000).rd, 350);
});

test('season keys follow the league time zone', () => {
  const t = Date.UTC(2026, 11, 1, 3, 0); // Dec 1 03:00 UTC = Nov 30 21:00 in Chicago
  assert.equal(seasonKey(t, 'America/Chicago'), '2026-11');
  assert.equal(seasonKey(t, 'UTC'), '2026-12');
  assert.equal(seasonStart('2026-12', 'America/Chicago'), Date.UTC(2026, 11, 1, 6, 0)); // CST is UTC-6
  assert.equal(nextSeasonKey('2026-12'), '2027-01');
});

let n = 0;
const M = (a, b, ca, cb, t, extra = {}) => ({ id: 'm' + (++n), a, b, ca, cb, winner: ca > cb ? 'a' : cb > ca ? 'b' : 'draw', playedAt: t, createdAt: n, ranked: true, ...extra });

test('soft reset at the month boundary, champion crowned for finished seasons', () => {
  const P = { x: { id: 'x', name: 'X' }, y: { id: 'y', name: 'Y' } };
  const matches = {};
  const oct = Date.UTC(2026, 9, 10, 18);
  for (let i = 0; i < MIN_CHAMP_GAMES; i++) { const m = M('x', 'y', 3, 0, oct + i * 36e5); matches[m.id] = m; }
  const nov = Date.UTC(2026, 10, 5, 18);
  const m2 = M('y', 'x', 1, 0, nov); matches[m2.id] = m2;
  const L = computeLeague({ players: P, matches }, { tz: 'America/Chicago', now: Date.UTC(2026, 10, 12, 18) });

  assert.deepEqual(L.seasons, ['2026-11', '2026-10']);
  const octX = L.byKey['2026-10'].st.x, novX = L.byKey['2026-11'].st.x;
  assert.equal(octX.w, MIN_CHAMP_GAMES);
  assert.equal(novX.games, 1, 'season stats only count that month');
  // Season starts from the carried-over rating
  near(novX.hist[0], START_R + (octX.r - START_R) * SEASON_CARRY, 1e-9, 'carry');
  assert.ok(L.byKey['2026-11'].st.x.hist[0] < octX.r);
  assert.deepEqual(L.champions.map(c => [c.key, c.id]), [['2026-10', 'x']]);
  assert.equal(L.champCount.x, 1);
  // All-time view has no reset and counts everything
  assert.equal(L.all.st.x.games, MIN_CHAMP_GAMES + 1);
  // New season puts everyone back in placements
  assert.ok(L.byKey['2026-11'].st.y.rd >= SEASON_RD_FLOOR || tier(L.byKey['2026-11'].st.y).name === 'Placement');
  assert.ok(L.byKey['2026-10'].delta[m2.id] === undefined && L.byKey['2026-11'].delta[m2.id].pA < 0.5, 'underdog odds recorded');
});

test('unrated matches count for the record only', () => {
  const P = { x: { id: 'x' }, y: { id: 'y' } };
  const m = M('x', 'y', 2, 1, Date.UTC(2026, 10, 5), { ranked: false });
  const L = computeLeague({ players: P, matches: { [m.id]: m } }, { tz: 'UTC', now: Date.UTC(2026, 10, 6) });
  const s = L.byKey['2026-11'].st.x;
  assert.equal(s.w, 1); assert.equal(s.r, START_R); assert.equal(s.ranked, 0);
});

test('card stats: usage, deck records, matchups', () => {
  const card = (id, name) => ({ id, name, elixir: 4, evo: false, icon: '' });
  const hog = card(1, 'Hog Rider'), log = card(2, 'The Log'), golem = card(3, 'Golem'), nw = card(4, 'Night Witch');
  const d1 = { cards: [hog, log] }, d2 = { cards: [golem, nw] };
  const ms = [
    M('x', 'y', 1, 0, 1, { deckA: d1, deckB: d2 }),
    M('y', 'x', 2, 0, 2, { deckA: d2, deckB: d1 }),
    M('x', 'y', 3, 1, 3, { deckA: d1, deckB: d2 }),
    M('x', 'y', 1, 0, 4), // no deck data: ignored
  ];
  const cs = cardStats('x', ms);
  assert.equal(cs.games, 3);
  assert.equal(cs.decks.length, 1);
  assert.equal(cs.decks[0].w, 2); assert.equal(cs.decks[0].l, 1);
  assert.equal(cs.cards.find(c => c.card.name === 'Hog Rider').n, 3);
  near(cs.vs.find(c => c.card.name === 'Golem').rate, 2 / 3, 1e-9, 'win rate vs Golem');
});

test('crown margin: bigger wins move ratings more, weighted by surprise', () => {
  assert.equal(marginMult(1, 0.5), 1);
  near(marginMult(2, 0.5), 1.15, 1e-12, 'even 2-crown');
  near(marginMult(3, 0.5), 1.3, 1e-12, 'even 3-crown');
  assert.ok(marginMult(3, 0.2) > marginMult(3, 0.5), 'underdog stomp counts more');
  assert.ok(marginMult(3, 0.9) < marginMult(3, 0.5) && marginMult(3, 0.9) > 1, 'favorite stomp counts a little');
  assert.equal(marginMult(0, 0.5), 1, 'tiebreaker win has no margin bonus');

  // Same matchup, 3-0 vs 1-0: bigger move, identical RD (margin doesn't make the system more certain)
  const P = { x: { id: 'x' }, y: { id: 'y' } };
  const t = Date.UTC(2026, 10, 5);
  const run = (ca, cb) => computeLeague({ players: P, matches: { m: { id: 'm', a: 'x', b: 'y', ca, cb, winner: ca > cb ? 'a' : 'b', playedAt: t, createdAt: 1, ranked: true } } }, { tz: 'UTC', now: t + 1000 }).byKey['2026-11'];
  const one = run(1, 0), three = run(3, 0);
  near(three.delta.m.a, one.delta.m.a * 1.3, 1e-9, '3-crown is 1.3x a 1-crown between equals');
  near(three.delta.m.b, one.delta.m.b * 1.3, 1e-9, 'loser drops 1.3x too');
  near(three.st.x.rd, one.st.x.rd, 1e-9, 'RD unaffected');
});

test('conservative score: a hot start with high RD ranks below a proven player', async () => {
  const { ranking, scoreOf } = await import('../public/rating.js');
  const P = { vet: { id: 'vet', name: 'Vet' }, rook: { id: 'rook', name: 'Rook' }, foe: { id: 'foe', name: 'Foe' } };
  const matches = {}; let t = Date.UTC(2026, 10, 2, 18);
  // Vet: 30 games, mostly wins vs foe -> high rating, low RD
  for (let i = 0; i < 30; i++) { const m = M(i % 4 ? 'vet' : 'foe', i % 4 ? 'foe' : 'vet', 1, 0, (t += 36e5)); matches[m.id] = m; }
  // Rook: one win over vet in their first game -> big rating jump but very uncertain
  { const m = M('rook', 'vet', 2, 0, (t += 36e5)); matches[m.id] = m; }
  const L = computeLeague({ players: P, matches }, { tz: 'UTC', now: t + 1000 });
  const v = L.byKey['2026-11'];
  assert.ok(v.st.rook.r > v.st.vet.r, 'rook has the higher raw rating');
  assert.ok(v.st.rook.rd > v.st.vet.rd, 'but is less certain');
  near(v.st.rook.score, scoreOf(v.st.rook.r, v.st.rook.rd), 1e-9, 'score = r - 2RD');
  assert.deepEqual(ranking({ players: P }, v).map(p => p.id).slice(0, 2), ['vet', 'rook'], 'proven player ranks first');
  assert.ok(v.st.rook.lastScore != null && v.st.rook.scoreHist.length === 2);
});

test('pre-game ratings are the real "before" values for back-to-back games', () => {
  const P = { x: { id: 'x' }, y: { id: 'y' } };
  const t = Date.UTC(2026, 10, 5, 18);
  const m1 = M('x', 'y', 1, 0, t), m2 = M('x', 'y', 1, 0, t + 600000); // 10 minutes apart: no idle days
  const L = computeLeague({ players: P, matches: { [m1.id]: m1, [m2.id]: m2 } }, { tz: 'UTC', now: t + 7200000 });
  const v = L.byKey['2026-11'];
  const d1 = v.delta[m1.id], d2 = v.delta[m2.id];
  assert.equal(d1.preA, START_R, 'first game starts from 1500');
  near(d2.preA, d1.preA + d1.a, 1e-9, "second game's before = first game's after");
  near(v.st.x.lastScore, v.st.x.scoreHist[2] - v.st.x.scoreHist[1], 1e-9, 'score change is not zero');
  assert.ok(Math.abs(v.st.x.lastScore) > 0.5);
});
