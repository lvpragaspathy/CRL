import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compute, expected, START, K_NEW, PROV, tier } from '../public/elo.js';

const P = { a: { id: 'a' }, b: { id: 'b' } };
let n = 0;
const match = (a, b, ca, cb, extra = {}) => {
  n++;
  const winner = ca > cb ? 'a' : cb > ca ? 'b' : 'draw';
  return { id: 'm' + n, a, b, ca, cb, winner, playedAt: n * 1000, createdAt: n, ranked: true, ...extra };
};

test('expected score is symmetric', () => {
  assert.equal(expected(1000, 1000), 0.5);
  assert.ok(Math.abs(expected(1200, 1000) + expected(1000, 1200) - 1) < 1e-12);
});

test('first win between equals moves both by K_NEW/2', () => {
  const m = match('a', 'b', 1, 0);
  const { st } = compute({ players: P, matches: { [m.id]: m } });
  assert.equal(st.a.rating, START + K_NEW / 2);
  assert.equal(st.b.rating, START - K_NEW / 2);
});

test('three-crown win is worth 1.3x', () => {
  const m = match('a', 'b', 3, 0);
  const { st } = compute({ players: P, matches: { [m.id]: m } });
  assert.ok(Math.abs(st.a.rating - (START + 1.3 * K_NEW / 2)) < 1e-9);
});

test('unrated matches count for record but not rating', () => {
  const m = match('a', 'b', 2, 1, { ranked: false });
  const { st } = compute({ players: P, matches: { [m.id]: m } });
  assert.equal(st.a.rating, START);
  assert.equal(st.a.w, 1);
});

test('order is by playedAt, not insertion', () => {
  const late = match('a', 'b', 1, 0); const early = match('b', 'a', 1, 0);
  early.playedAt = 0;
  const { ms } = compute({ players: P, matches: { [late.id]: late, [early.id]: early } });
  assert.equal(ms[0].id, early.id);
});

test('placement ends after PROV rated games', () => {
  const matches = {};
  for (let i = 0; i < PROV; i++) { const m = match('a', 'b', 1, 0); matches[m.id] = m; }
  const { st } = compute({ players: P, matches });
  assert.notEqual(tier(st.a).cls, 't-place');
  assert.equal(st.a.streakN, PROV);
});
