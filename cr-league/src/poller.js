import { battleToMatch } from './battles.js';
import { newId } from './validate.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function explain(status, tag) {
  switch (status) {
    case 400: return `The API rejected the request for ${tag}. Check the player tag.`;
    case 401:
    case 403: return 'The Clash Royale API rejected the key (403). If CR_API_BASE is the RoyaleAPI proxy, add 45.79.218.79 to the key\'s allowed IPs; otherwise add this server\'s outbound IP.';
    case 404: return `No player found for tag ${tag}. Fix the tag on their profile.`;
    case 429: return 'Rate limited by the Clash Royale API. Raise POLL_MINUTES.';
    case 503: return 'The Clash Royale API is down for maintenance. It will retry on the next poll.';
    default: return `The Clash Royale API returned ${status}.`;
  }
}

/**
 * Store one parsed battle. Returns 'exists' (already imported or deleted on purpose),
 * 'linked' (merged into a matching manual entry), or 'inserted'.
 */
export async function ingestBattle(store, m, { linkWindowMs }) {
  // Keep the full battle JSON: the log only holds 25 battles, so anything we don't save now is gone.
  if (m.raw) await store.saveRaw(m.battleKey, m.raw, m.playedAt);
  const existing = await store.findMatchByKey(m.battleKey);
  if (existing) {
    // Fill in whatever an older import didn't capture (decks, elixir/HP stats) while the battle is
    // still in someone's last 25.
    if (existing.deleted) return 'exists';
    const flipped = existing.a === m.b;
    const fill = {};
    if (!existing.deckA && !existing.deckB && (m.deckA || m.deckB)) Object.assign(fill, flipped ? { deckA: m.deckB, deckB: m.deckA } : { deckA: m.deckA, deckB: m.deckB });
    if (!existing.stats && m.stats) fill.stats = flipped ? { a: m.stats.b, b: m.stats.a } : m.stats;
    if (!Object.keys(fill).length) return 'exists';
    await store.updateMatch(existing.id, fill);
    return 'enriched';
  }
  const apiFields = {
    a: m.a, b: m.b, ca: m.ca, cb: m.cb, winner: m.winner, playedAt: m.playedAt,
    mode: m.mode, source: 'api', battleKey: m.battleKey, tiebreak: m.tiebreak,
    deckA: m.deckA || null, deckB: m.deckB || null, stats: m.stats || null,
  };
  const candidates = await store.findLinkCandidates(m.a, m.b, m.playedAt, linkWindowMs);
  if (candidates.length) {
    candidates.sort((x, y) => Math.abs(x.playedAt - m.playedAt) - Math.abs(y.playedAt - m.playedAt));
    // Keep the manual entry's notes and rated/unrated choice; the API wins on everything it knows.
    await store.updateMatch(candidates[0].id, apiFields);
    return 'linked';
  }
  const ok = await store.insertMatch({ id: newId('m'), createdAt: Date.now(), notes: '', ranked: true, ...apiFields });
  return ok ? 'inserted' : 'exists';
}

export function createPoller({ store, config, log = console }) {
  const status = {
    enabled: !!config.crToken,
    intervalMinutes: config.pollMinutes,
    running: false,
    lastRunAt: null,
    lastOkAt: null,
    lastError: config.crToken ? null : 'Auto-tracking is off: CR_API_TOKEN is not set on the server.',
    lastResult: null,
    nextRunAt: null,
  };
  let timer = null;

  async function fetchLog(tag) {
    const url = `${config.crBase}/players/${encodeURIComponent(tag)}/battlelog`;
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${config.crToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new ApiError(0, `Couldn't reach the Clash Royale API (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`);
    }
    if (!res.ok) throw new ApiError(res.status, explain(res.status, tag));
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }

  async function fetchProfile(tag) {
    const res = await fetch(`${config.crBase}/players/${encodeURIComponent(tag)}`, {
      headers: { Authorization: `Bearer ${config.crToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new ApiError(res.status, explain(res.status, tag));
    const d = await res.json();
    return {
      trophies: Number.isFinite(d.trophies) ? d.trophies : null,
      best: Number.isFinite(d.bestTrophies) ? d.bestTrophies : null,
      at: Date.now(),
    };
  }

  /** Refresh ladder trophies for anyone whose snapshot is missing or older than profileMinutes. */
  async function refreshProfiles(players, result) {
    const stale = Date.now() - (config.profileMinutes || 60) * 60000;
    for (const p of players) {
      if (p.archived || !p.tag || (p.ladder && p.ladder.at > stale)) continue;
      try {
        const ladder = await fetchProfile(p.tag);
        await store.updatePlayer(p.id, { ladder });
        result.profiles++;
      } catch (e) {
        status.profileError = e.message; // shown nowhere prominent: trophies are a side detail
        if (e.status === 401 || e.status === 403 || e.status === 503) break;
      }
      await sleep(200);
    }
  }

  async function runOnce() {
    if (!config.crToken) return status;
    if (status.running) return status;
    status.running = true;
    status.lastRunAt = Date.now();
    const result = { checked: 0, found: 0, inserted: 0, linked: 0, enriched: 0, profiles: 0 };
    const catalog = new Map();
    const errors = [];
    try {
      const players = (await store.listPlayers()).filter(p => p.tag);
      const byTag = new Map(players.map(p => [p.tag, p]));
      const leagueTags = new Set(byTag.keys());
      const parsed = new Map();
      // Each battle shows up in both players' logs; polling everyone means a battle is caught even if
      // one player plays 25+ other games before the next poll.
      for (const p of players.filter(p => !p.archived)) {
        try {
          const battles = await fetchLog(p.tag);
          result.checked++;
          for (const b of battles) {
            const m = battleToMatch(b, leagueTags, { types: config.friendlyTypes, inferTiebreak: config.inferTiebreak });
            if (m && !parsed.has(m.battleKey)) parsed.set(m.battleKey, m);
            if (m) for (const c of m.cards) if (c.id && !catalog.has(c.id)) catalog.set(c.id, c);
          }
        } catch (e) {
          errors.push(e.status === 404 ? `${p.name}: ${e.message}` : e.message);
          if (e.status === 401 || e.status === 403 || e.status === 503) break; // no point trying the rest
        }
        await sleep(200);
      }
      result.found = parsed.size;
      const authFailed = errors.some(e => /\(403\)/.test(e));
      if (!authFailed) await refreshProfiles(players, result);
      if (catalog.size) await store.upsertCards([...catalog.values()]);
      // Oldest first, so ties in playedAt keep a stable order.
      for (const m of [...parsed.values()].sort((x, y) => x.playedAt - y.playedAt)) {
        const r = await ingestBattle(store, { ...m, a: byTag.get(m.aTag).id, b: byTag.get(m.bTag).id },
          { linkWindowMs: config.linkWindowMinutes * 60000 });
        if (r === 'inserted') result.inserted++;
        if (r === 'linked') result.linked++;
        if (r === 'enriched') result.enriched++;
      }
    } catch (e) {
      errors.push(`Sync failed: ${e.message}`);
    } finally {
      status.running = false;
    }
    status.lastResult = result;
    status.lastError = errors.length ? [...new Set(errors)].join(' ') : null;
    if (!errors.length) status.lastOkAt = Date.now();
    if (result.inserted || result.linked || result.enriched || errors.length) {
      log.info?.(`[sync] checked ${result.checked}, found ${result.found}, new ${result.inserted}, merged ${result.linked}, decks added ${result.enriched}${errors.length ? ', errors: ' + status.lastError : ''}`);
    }
    return status;
  }

  function schedule(delayMs) {
    clearTimeout(timer);
    status.nextRunAt = Date.now() + delayMs;
    timer = setTimeout(async () => {
      await runOnce();
      schedule(config.pollMinutes * 60000);
    }, delayMs);
    timer.unref?.();
  }

  return {
    status: () => ({ ...status }),
    runOnce,
    start() { if (config.crToken) schedule(5000); },
    stop() { clearTimeout(timer); status.nextRunAt = null; },
  };
}
