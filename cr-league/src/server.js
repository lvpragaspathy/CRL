import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { createMemoryStore } from './store-memory.js';
import { createPgStore } from './store-pg.js';
import { createPoller } from './poller.js';
import { HttpError, playerInput, matchInput, isId, newId } from './validate.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

export async function createApp({ store, poller, cfg = config }) {
  const hash = s => createHash('sha256').update(String(s)).digest();
  const pwHash = cfg.password ? hash(cfg.password) : null;

  async function requireAuth(req) {
    if (!pwHash) throw new HttpError(403, 'Editing is locked because LEAGUE_PASSWORD is not set on the server.');
    const given = req.headers['x-league-password'];
    if (!given || !timingSafeEqual(hash(given), pwHash)) {
      await new Promise(r => setTimeout(r, 400)); // slow down guessing
      throw new HttpError(401, 'Wrong league password.');
    }
  }
  async function readJson(req) {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 2e6) throw new HttpError(413, 'That request is too large.'); chunks.push(c); }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HttpError(400, 'The request body is not valid JSON.'); }
  }
  async function snapshot() {
    const [league, players, matches] = await Promise.all([store.getLeague(), store.listPlayers(), store.listMatches()]);
    return { league, players, matches, sync: poller.status(), auth: { editable: !!pwHash } };
  }
  async function assertPlayers(...ids) {
    for (const id of ids) if (!(await store.getPlayer(id))) throw new HttpError(400, 'One of those players is no longer in the league.');
  }

  // [method, pattern, auth, handler(req, params, body)]
  const routes = [
    ['GET', /^\/api\/league$/, false, () => snapshot()],
    ['GET', /^\/api\/auth$/, true, () => ({ ok: true })],
    ['PATCH', /^\/api\/league$/, true, async (req, p, body) => {
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
      if (!name) throw new HttpError(400, 'The league needs a name.');
      return store.setLeague({ name });
    }],

    ['POST', /^\/api\/players$/, true, async (req, p, body) => {
      const fields = playerInput(body);
      if (await store.tagTaken(fields.tag)) throw new HttpError(409, `Another player already has the tag ${fields.tag}.`);
      if ((await store.listPlayers()).some(x => x.name.toLowerCase() === fields.name.toLowerCase())) throw new HttpError(409, 'Someone in the league already has that name.');
      return store.insertPlayer({ id: newId('p'), createdAt: Date.now(), ...fields });
    }],
    ['PATCH', /^\/api\/players\/([\w-]+)$/, true, async (req, [id], body) => {
      if (!(await store.getPlayer(id))) throw new HttpError(404, 'That player no longer exists.');
      const fields = playerInput(body, { partial: true });
      if ('tag' in fields && await store.tagTaken(fields.tag, id)) throw new HttpError(409, `Another player already has the tag ${fields.tag}.`);
      if ('name' in fields && (await store.listPlayers()).some(x => x.id !== id && x.name.toLowerCase() === fields.name.toLowerCase())) throw new HttpError(409, 'Someone in the league already has that name.');
      return store.updatePlayer(id, fields);
    }],
    ['DELETE', /^\/api\/players\/([\w-]+)$/, true, async (req, [id]) => {
      if (await store.countLiveMatchesFor(id)) throw new HttpError(409, 'This player has matches. Retire them instead so the ratings stay intact.');
      await store.deletePlayer(id); return { ok: true };
    }],

    ['POST', /^\/api\/matches$/, true, async (req, p, body) => {
      const m = matchInput(body);
      await assertPlayers(m.a, m.b);
      const match = { id: newId('m'), createdAt: Date.now(), source: 'manual', battleKey: null, tiebreak: false, ...m };
      await store.insertMatch(match); return match;
    }],
    ['PATCH', /^\/api\/matches\/([\w-]+)$/, true, async (req, [id], body) => {
      const existing = await store.getMatch(id);
      if (!existing) throw new HttpError(404, 'That match no longer exists.');
      const m = matchInput(body, { partial: true, existing });
      await assertPlayers(m.a, m.b);
      const { id: _i, createdAt, source, battleKey, ...fields } = m;
      return store.updateMatch(id, fields);
    }],
    ['DELETE', /^\/api\/matches\/([\w-]+)$/, true, async (req, [id]) => { await store.deleteMatch(id); return { ok: true }; }],

    ['POST', /^\/api\/sync$/, true, async () => {
      if (!cfg.crToken) throw new HttpError(400, 'Auto-tracking is off: set CR_API_TOKEN on the server first.');
      return poller.runOnce();
    }],

    // Accepts the "Copy data as JSON" export. Merges: anything whose id already exists is skipped.
    ['POST', /^\/api\/import$/, true, async (req, p, body) => {
      const inP = Array.isArray(body.players) ? body.players : [], inM = Array.isArray(body.matches) ? body.matches : [];
      const idMap = new Map(); let players = 0, matches = 0, skipped = 0;
      for (const raw of inP) {
        let fields;
        try { fields = playerInput(raw); } catch { skipped++; continue; }
        const id = isId(raw.id) ? raw.id : newId('p');
        if (await store.getPlayer(id)) { idMap.set(raw.id, id); skipped++; continue; }
        if (await store.tagTaken(fields.tag)) fields.tag = '';
        await store.insertPlayer({ id, createdAt: Number(raw.createdAt) || Date.now(), ...fields });
        idMap.set(raw.id, id); players++;
      }
      for (const raw of inM) {
        try {
          const m = matchInput({ ...raw, a: idMap.get(raw.a) ?? raw.a, b: idMap.get(raw.b) ?? raw.b });
          await assertPlayers(m.a, m.b);
          const ok = await store.insertMatch({ id: isId(raw.id) ? raw.id : newId('m'), createdAt: Number(raw.createdAt) || Date.now(), source: 'manual', battleKey: null, tiebreak: false, ...m });
          ok ? matches++ : skipped++;
        } catch { skipped++; }
      }
      if (body.league && typeof body.league.name === 'string' && body.league.name.trim()) await store.setLeague({ name: body.league.name.trim().slice(0, 40) });
      return { players, matches, skipped };
    }],
  ];

  async function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(404).end(); return; }
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://local');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok'); return; }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      return serveStatic(req, res, url.pathname);
    }
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    try {
      const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (!route) return send(routes.some(([, re]) => re.test(url.pathname)) ? 405 : 404, { error: 'Not found.' });
      const [, re, auth, fn] = route;
      if (auth) await requireAuth(req);
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJson(req) : {};
      const out = await fn(req, re.exec(url.pathname).slice(1), body);
      send(200, out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      if (e && e.code === '23505') return send(409, { error: 'That conflicts with an existing record (duplicate tag or id).' });
      console.error(e);
      send(500, { error: 'Something went wrong on the server. Check the logs.' });
    }
  };
}

// Boot when run directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = config.databaseUrl ? await createPgStore(config.databaseUrl, { ssl: config.pgSsl }) : createMemoryStore();
  await store.init();
  const poller = createPoller({ store, config });
  const server = http.createServer(await createApp({ store, poller }));
  server.listen(config.port, () => {
    console.log(`League running on :${config.port} (store: ${store.kind}, auto-sync: ${config.crToken ? `every ${config.pollMinutes} min via ${config.crBase}` : 'off'})`);
    if (store.kind === 'memory') console.warn('No DATABASE_URL set: data lives in memory and is lost on restart.');
    if (!config.password) console.warn('No LEAGUE_PASSWORD set: the league is view-only.');
  });
  poller.start();
  const shutdown = async () => { poller.stop(); server.close(); await store.close(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
