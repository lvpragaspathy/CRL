import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLeague } from '../public/rating.js';
import { hpInfo, clutch, leaks, tilt, heatmap, archetype, meta, race, records, weekly, scorePreds, calibration, eloPreds, tune, CLOSE_HP } from '../public/stats.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ${b}, got ${a}`);
const S = (leaked, king, princess) => ({ leaked, king, princess });
let n = 0;
const M = (a, b, ca, cb, t, extra = {}) => ({ id: 'm' + (++n), a, b, ca, cb, winner: ca > cb ? 'a' : cb > ca ? 'b' : 'draw', playedAt: t, createdAt: n, ranked: true, ...extra });
const P = { x: { id: 'x', name: 'X' }, y: { id: 'y', name: 'Y' }, z: { id: 'z', name: 'Z' } };
const T0 = Date.UTC(2026, 10, 2, 18); // a Monday, 12:00 in Chicago

test('hpInfo: destroyed towers and three-crowns', () => {
  // 3-0: loser's towers all down even though the log has no HP fields for them
  const m1 = M('x', 'y', 3, 0, T0, { stats: { a: S(1, 4824, [3052, 2000]), b: S(4, null, []) } });
  const h1 = hpInfo(m1);
  assert.equal(h1.hpB, 0); assert.equal(h1.hpA, 4824 + 3052 + 2000); assert.equal(h1.close, false);
  // 1-0 where the winner was nearly dead: close
  const m2 = M('x', 'y', 1, 0, T0, { stats: { a: S(1, 4824, [200, 300]), b: S(1, 4824, [3052]) } });
  const h2 = hpInfo(m2);
  assert.equal(h2.margin, 4824 + 500 - (4824 + 3052));
  assert.ok(h2.margin <= CLOSE_HP && h2.close);
  // King standing but no HP in the log: unknown
  assert.equal(hpInfo(M('x', 'y', 1, 0, T0, { stats: { a: S(1, null, []), b: S(1, 4824, [3052]) } })), null);
  assert.equal(hpInfo(M('x', 'y', 1, 0, T0)), null);
});

test('clutch and leaks per player', () => {
  const ms = [
    M('x', 'y', 1, 0, T0, { stats: { a: S(1, 4824, [200, 300]), b: S(5, 4824, [3052]) } }),     // close, x wins
    M('y', 'x', 1, 0, T0 + 1e6, { stats: { a: S(2, 4824, [100, 100]), b: S(3, 4824, [3052]) } }), // close, y wins
    M('x', 'y', 3, 0, T0 + 2e6, { stats: { a: S(0, 4824, [3052, 3052]), b: S(7, null, []) } }),  // blowout
  ];
  const view = { ms };
  const c = clutch({ players: P }, view);
  const cx = c.find(r => r.id === 'x');
  assert.deepEqual([cx.close.n, cx.close.w, cx.close.l], [2, 1, 1]);
  assert.equal(cx.n, 3);
  const lx = leaks({ players: P }, view).find(r => r.id === 'x');
  near(lx.avg, (1 + 3 + 0) / 3, 1e-9, 'avg leaked');
  near(lx.avgWin, 0.5, 1e-9, 'leaked in wins'); near(lx.avgLoss, 3, 1e-9, 'leaked in losses');
  assert.equal(leaks({ players: P }, view).find(r => r.id === 'y').max.v, 7);
});

test('tilt: after-win / after-loss and sessions split by a 45 min gap', () => {
  const ms = [
    M('x', 'y', 1, 0, T0),               // session 1 game 1: x W
    M('x', 'y', 0, 1, T0 + 10 * 60000),  // session 1 game 2: x L (after a win)
    M('x', 'y', 1, 0, T0 + 20 * 60000),  // session 1 game 3: x W (after a loss)
    M('x', 'y', 1, 0, T0 + 3 * 3600000), // session 2 game 1: x W (after a win)
  ];
  const t = tilt({ players: P }, { ms }).find(r => r.id === 'x');
  assert.deepEqual([t.afterW.n, t.afterW.w], [2, 1]);
  assert.deepEqual([t.afterL.n, t.afterL.w], [1, 1]);
  assert.deepEqual([t.first.n, t.first.w], [2, 2]);
  assert.deepEqual([t.later.n, t.later.w], [2, 1]);
});

test('heatmap uses the league time zone', () => {
  const hm = heatmap({ ms: [M('x', 'y', 1, 0, T0)] }, 'America/Chicago');
  assert.equal(hm.grid[0][12], 1, 'Monday noon in Chicago');
  assert.equal(hm.max, 1);
});

test('archetypes and league meta', () => {
  const card = name => ({ id: name, name });
  const lavaloon = { cards: ['Lava Hound', 'Balloon', 'Arrows', 'Minions'].map(card) };
  const hog = { cards: ['Hog Rider', 'The Log', 'Cannon', 'Musketeer'].map(card) };
  assert.equal(archetype(lavaloon), 'Lava Hound + Balloon');
  assert.equal(archetype(hog), 'Hog Rider');
  assert.equal(archetype({ cards: [card('Knight')] }), 'Control');
  const mt = meta({ players: P }, { ms: [M('x', 'y', 1, 0, T0, { deckA: hog, deckB: lavaloon }), M('x', 'z', 0, 2, T0, { deckA: hog, deckB: hog })] });
  assert.equal(mt.decks, 4);
  const h = mt.archetypes.find(a => a.name === 'Hog Rider');
  assert.deepEqual([h.n, h.w, h.l], [3, 2, 1]);
  assert.equal(h.mains[0].pid, 'x');
  near(mt.cards.find(c => c.card.name === 'Hog Rider').usage, 0.75, 1e-9, 'usage');
});

test('race, records and weekly recap on a computed league', () => {
  const now = Date.UTC(2026, 10, 12, 18);
  const ms = {};
  for (let i = 0; i < 6; i++) { const m = M('x', 'y', i % 3 === 2 ? 0 : 3, i % 3 === 2 ? 1 : 0, now - (6 - i) * 36e5); ms[m.id] = m; }
  const data = { players: P, matches: ms };
  const L = computeLeague(data, { tz: 'America/Chicago', now });
  const r = race(data, L, L.currentKey, 'America/Chicago');
  assert.equal(r.series.length, 2);
  assert.equal(r.series[0].id, 'x', 'leader first');
  assert.equal(r.series[0].pts[0].r, 1500);
  const rec = records(data, L, 'America/Chicago');
  assert.equal(rec.find(x => x.key === 'streak').value, '2 wins');
  assert.equal(rec.find(x => x.key === 'three').value, '4 three-crowns');
  assert.ok(rec.find(x => x.key === 'upset'), 'y beating the leader counts as an upset');
  // Every game here is a placement game (RD starts at 350), so no rating-gain records yet
  assert.equal(rec.find(x => x.key === 'gain'), undefined);
  const wk = weekly(data, L, now);
  assert.equal(wk.battles, 6); assert.equal(wk.threes, 4);
  assert.equal(wk.mostWins.id, 'x');
});

test('prediction scoring, calibration buckets, Elo baseline, tuning split', () => {
  const s = scorePreds([{ p: 0.8, s: 1 }, { p: 0.8, s: 0 }, { p: 0.5, s: 0.5 }]);
  near(s.brier, (0.04 + 0.64 + 0) / 3, 1e-12, 'brier');
  near(s.accuracy, 0.5, 1e-12, 'accuracy');
  const cal = calibration([{ p: 0.75, s: 1 }, { p: 0.25, s: 0 }, { p: 0.72, s: 0 }, { p: 0.95, s: 1 }]);
  const b70 = cal.find(b => b.lo === 0.7);
  assert.equal(b70.n, 3, 'a 25% underdog is a 75% favorite from the other side');
  near(b70.actual, 2 / 3, 1e-12, 'bucket hit rate');
  assert.equal(cal.find(b => b.lo === 0.9).n, 1);

  const few = tune({ players: P, matches: {} }, { tz: 'UTC', now: T0 });
  assert.equal(few.tooFew, true);
  // A league where x is clearly better: tuned params shouldn't be worse in-sample than current
  const ms = {};
  for (let i = 0; i < 40; i++) { const m = M(i % 2 ? 'x' : 'z', 'y', i % 5 ? 2 : 0, i % 5 ? 0 : 1, T0 + i * 36e5); ms[m.id] = m; }
  const data = { players: P, matches: ms };
  const t = tune(data, { tz: 'UTC', now: T0 + 50 * 36e5 }, { grid: { tau: [0.5, 1.2], carry: [0.5], rdFloor: [150], marginScale: [0, 1] } });
  assert.equal(t.tried, 4); assert.equal(t.n, 40); assert.equal(t.cut, 28);
  assert.ok(t.best.train <= t.current.train + 1e-12);
  assert.equal(eloPreds(data, { tz: 'UTC', now: T0 }).length, 40);
});
