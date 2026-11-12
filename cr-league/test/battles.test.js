import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normTag, isValidTag, parseBattleTime, battleToMatch, prettyMode, battleKey } from '../src/battles.js';
import { logs, TAGS, T1, T2 } from './fixtures.js';
import { extractDeck } from '../src/battles.js';

const league = new Set([TAGS.lucas, TAGS.ava, TAGS.ben]);
const opts = { types: ['friendly', 'clanMate'], inferTiebreak: true };

test('normTag cleans up user input', () => {
  assert.equal(normTag(' 2pyq8lv0 '), '#2PYQ8LV0');
  assert.equal(normTag('#9vug0p'), '#9VUG0P');
  assert.equal(normTag('#9VUGOP'), '#9VUG0P', 'letter O becomes zero');
  assert.ok(isValidTag('#2PYQ8LV0'));
  assert.ok(!isValidTag('#ABCDEF'));
});

test('parseBattleTime reads the API timestamp format', () => {
  assert.equal(parseBattleTime('20261112T201500.000Z'), Date.UTC(2026, 10, 12, 20, 15, 0));
  assert.equal(parseBattleTime('garbage'), null);
});

test('same battle from both logs produces the same match', () => {
  const fromLucas = battleToMatch(logs[TAGS.lucas][0], league, opts);
  const fromAva = battleToMatch(logs[TAGS.ava][0], league, opts);
  assert.deepEqual(fromLucas, fromAva);
  assert.equal(fromLucas.battleKey, battleKey(T1, TAGS.ava, TAGS.lucas));
  // sides are ordered by tag: #2PYQ8LV0 (Lucas) < #Q8RL2YJ (Ava)
  assert.equal(fromLucas.aTag, TAGS.lucas);
  assert.equal(fromLucas.ca, 3); assert.equal(fromLucas.cb, 1); assert.equal(fromLucas.winner, 'a');
});

test('level crowns use tower HP as the tiebreaker', () => {
  const m = battleToMatch(logs[TAGS.lucas][1], league, opts);
  assert.equal(m.battleKey.startsWith(T2), true);
  assert.equal(m.ca, 1); assert.equal(m.cb, 1);
  assert.equal(m.tiebreak, true);
  assert.equal(m.winner, m.aTag === TAGS.lucas ? 'a' : 'b');
  const noInfer = battleToMatch(logs[TAGS.lucas][1], league, { ...opts, inferTiebreak: false });
  assert.equal(noInfer.winner, 'draw');
});

test('ignores ladder, non-members and 2v2', () => {
  assert.equal(battleToMatch(logs[TAGS.lucas][2], league, opts), null);
  assert.equal(battleToMatch(logs[TAGS.lucas][3], league, opts), null);
  assert.equal(battleToMatch(logs[TAGS.lucas][4], league, { types: ['clanMate2v2'] }), null);
});

test('prettyMode', () => {
  assert.equal(prettyMode('TripleElixir_Friendly'), 'Triple Elixir Friendly');
  assert.equal(prettyMode(undefined), 'Classic');
});

test('decks: compact deck per side plus a card catalog, evolutions flagged', () => {
  const m = battleToMatch(logs[TAGS.lucas][0], league, opts);
  assert.equal(m.deckA.cards.length, 8);
  assert.deepEqual(m.deckA.cards[3], { id: 26000010, evo: true });
  assert.equal(m.deckA.tower, 159000000);
  assert.equal(m.deckB.cards[0].id, 26000009, 'Ava (side B) has the Golem deck');
  const skel = m.cards.find(c => c.id === 26000010);
  assert.equal(skel.elixir, 1);
  assert.match(skel.iconEvo, /_evo\.png$/);
  // Same battle from Ava's log gives the same orientation
  assert.deepEqual(battleToMatch(logs[TAGS.ava][0], league, opts).deckA, m.deckA);
});

test('decks: missing cards -> null, foreign icon hosts dropped', () => {
  assert.equal(extractDeck({ cards: [] }), null);
  const d = extractDeck({ cards: [{ id: 1, name: 'X', iconUrls: { medium: 'https://evil.example/x.png' } }] });
  assert.equal(d.catalog[0].icon, '');
});
