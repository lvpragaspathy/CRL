// End to end: real HTTP server + memory store + a fake Clash Royale API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { createMemoryStore } from '../src/store-memory.js';
import { createPoller } from '../src/poller.js';
import { logs, TAGS, T1 } from './fixtures.js';
import { parseBattleTime } from '../src/battles.js';

let cr, app, base, cfg, poller;
const PW = 'hog-rider-2.6';

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));

before(async () => {
  cr = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer good-token') { res.writeHead(403).end('{"reason":"accessDenied.invalidIp"}'); return; }
    const m = /^\/v1\/players\/([^/]+)\/battlelog$/.exec(req.url);
    const tag = m && decodeURIComponent(m[1]);
    if (!tag || !logs[tag]) { res.writeHead(404).end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(logs[tag]));
  });
  const crBase = await listen(cr);
  cfg = { timezone: 'America/Chicago', crToken: 'good-token', crBase: crBase + '/v1', pollMinutes: 10, friendlyTypes: ['friendly', 'clanMate'], inferTiebreak: true, linkWindowMinutes: 15, password: PW };
  const store = createMemoryStore();
  poller = createPoller({ store, config: cfg, log: { info() {} } });
  app = http.createServer(await createApp({ store, poller, cfg }));
  base = await listen(app);
});
after(() => { app.close(); cr.close(); });

async function call(method, path, body, pw = PW) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(pw ? { 'X-League-Password': pw } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('full flow: players, manual log, sync, dedupe, merge, tombstones, import', async () => {
  // Auth
  assert.equal((await call('POST', '/api/players', { name: 'X' }, null)).status, 401);
  assert.equal((await call('POST', '/api/players', { name: 'X' }, 'nope')).status, 401);

  const add = async (name, tag) => (await call('POST', '/api/players', { name, tag, color: '#4a90ff' })).body;
  const lucas = await add('Lucas', '2pyq8lv0');
  const ava = await add('Ava', TAGS.ava);
  const ben = await add('Ben', TAGS.ben);
  assert.equal(lucas.tag, TAGS.lucas);
  assert.equal((await call('POST', '/api/players', { name: 'Dupe', tag: TAGS.ava })).status, 409);
  assert.equal((await call('POST', '/api/players', { name: 'Bad', tag: '#ABCDEF' })).status, 400);

  // Manual log 5 minutes after the real battle: should be merged, not duplicated
  const manual = await call('POST', '/api/matches', { a: ava.id, b: lucas.id, ca: 1, cb: 2, playedAt: parseBattleTime(T1) + 5 * 60000, notes: 'gg', ranked: true, mode: 'Classic' });
  assert.equal(manual.status, 200);

  // Sync once with decks stripped (like matches imported before deck tracking existed)...
  const saved = structuredClone(logs);
  for (const tag in logs) for (const b of logs[tag]) for (const s of [...b.team, ...b.opponent]) { s.cards = []; s.supportCards = []; }
  const s1 = (await call('POST', '/api/sync')).body;
  assert.equal(s1.lastError, null);
  assert.deepEqual(s1.lastResult, { checked: 3, found: 3, inserted: 2, linked: 1, enriched: 0 });
  // ...then again with decks: the existing match gets them filled in
  for (const tag in saved) logs[tag] = saved[tag];
  const s1b = (await call('POST', '/api/sync')).body;
  assert.equal(s1b.lastResult.enriched, 1);

  let league = (await call('GET', '/api/league', null, null)).body;
  assert.equal(league.matches.length, 3);
  const merged = league.matches.find(m => m.id === manual.body.id);
  assert.equal(merged.source, 'api');
  assert.equal(merged.notes, 'gg', 'manual notes survive the merge');
  assert.equal(merged.a, lucas.id); assert.equal(merged.ca, 3); assert.equal(merged.cb, 1);
  assert.equal(merged.deckA.cards[0].id, 26000021, 'Lucas (side A) got the Hog deck');
  assert.equal(merged.stats.a.king, 4824, 'tower HP captured, oriented with the match');
  assert.equal(merged.stats.a.leaked, 1.5);
  assert.equal(merged.deckB.cards[0].id, 26000009);
  assert.ok(league.cards.find(c => c.id === 26000021 && c.name === 'Hog Rider' && c.icon));
  assert.equal(league.settings.timezone, 'America/Chicago');
  const tb = league.matches.find(m => m.tiebreak);
  assert.ok(tb && tb.ca === tb.cb && tb.winner !== 'draw');
  assert.equal(tb.mode, 'Triple Elixir Friendly');

  // Second sync imports nothing new
  const s2 = (await call('POST', '/api/sync')).body;
  assert.equal(s2.lastResult.inserted, 0); assert.equal(s2.lastResult.linked, 0); assert.equal(s2.lastResult.enriched, 0);

  // Unchanged league -> 304 with the ETag
  const first = await fetch(base + '/api/league');
  const again = await fetch(base + '/api/league', { headers: { 'If-None-Match': first.headers.get('etag') } });
  assert.equal(again.status, 304);

  // Deleting an imported match keeps it from coming back
  const avaBen = league.matches.find(m => [m.a, m.b].sort().join() === [ava.id, ben.id].sort().join());
  assert.equal((await call('DELETE', `/api/matches/${avaBen.id}`)).status, 200);
  await call('POST', '/api/sync');
  league = (await call('GET', '/api/league', null, null)).body;
  assert.equal(league.matches.length, 2);

  // Edit a match; winner follows crowns
  const edited = (await call('PATCH', `/api/matches/${merged.id}`, { ca: 0, cb: 2 })).body;
  assert.equal(edited.winner, 'b');

  // Can't delete a player with matches; can retire
  assert.equal((await call('DELETE', `/api/players/${ben.id}`)).status, 409);
  assert.equal((await call('PATCH', `/api/players/${ben.id}`, { archived: true })).body.archived, true);

  // Import the artifact's "Copy data as JSON" format
  const imp = (await call('POST', '/api/import', {
    league: { name: 'The Boys League' },
    players: [{ id: 'pold1', name: 'Chris', tag: '', color: '#ff5367', createdAt: 1 }, { id: 'pold2', name: 'Dana', tag: '#LJC22Q', color: '#3fd68f', createdAt: 2 }],
    matches: [{ id: 'mold1', a: 'pold1', b: 'pold2', ca: 2, cb: 2, winner: 'draw', playedAt: Date.UTC(2026, 10, 1), createdAt: 3, ranked: true, mode: 'Draft', notes: '' }],
  })).body;
  assert.deepEqual(imp, { players: 2, matches: 1, skipped: 0 });
  league = (await call('GET', '/api/league', null, null)).body;
  assert.equal(league.league.name, 'The Boys League');
  assert.equal(league.players.length, 5);
});

test('rejected API key reports the whitelist fix', async () => {
  const bad = createPoller({ store: createMemoryStore(), config: { ...cfg, crToken: 'wrong' }, log: { info() {} } });
  const store2 = createMemoryStore();
  await store2.insertPlayer({ id: 'p1', name: 'L', tag: TAGS.lucas, color: '#4a90ff', deck: '', archived: false, createdAt: 1 });
  const p2 = createPoller({ store: store2, config: { ...cfg, crToken: 'wrong' }, log: { info() {} } });
  const st = await p2.runOnce();
  assert.match(st.lastError, /45\.79\.218\.79/);
  bad.stop();
});

test('static files and path traversal', async () => {
  const idx = await fetch(base + '/');
  assert.equal(idx.status, 200);
  assert.match(await idx.text(), /<title>/);
  assert.equal((await fetch(base + '/rating.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(base + '/..%2fpackage.json')).status, 404);
});

test('re-sync fills in elixir/HP stats on matches imported before stats existed', async () => {
  const { ingestBattle } = await import('../src/poller.js');
  const store = createMemoryStore();
  const base = { battleKey: 'k1', a: 'p1', b: 'p2', ca: 1, cb: 0, winner: 'a', tiebreak: false, playedAt: 1, mode: 'Friendly', deckA: null, deckB: null };
  assert.equal(await ingestBattle(store, { ...base, stats: null }, { linkWindowMs: 0 }), 'inserted');
  const stats = { a: { leaked: 0.5, king: 4000, princess: [100] }, b: { leaked: 3, king: 4824, princess: [3052] } };
  assert.equal(await ingestBattle(store, { ...base, stats, raw: { battleTime: 'x' } }, { linkWindowMs: 0 }), 'enriched');
  assert.deepEqual((await store.findMatchByKey('k1')).stats, stats);
  assert.equal(await ingestBattle(store, { ...base, stats }, { linkWindowMs: 0 }), 'exists');
  assert.equal(await store.countRaw(), 1);
});
