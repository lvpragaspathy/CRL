import {
  START_R, MIN_CHAMP_GAMES, PROVISIONAL_RD, RANKS, DIVISION_RP, computeLeague, rank, rankOf, isPlaced, ranking, pct, winProb, seasonLabel, seasonKey, cardStats, avgElixir, backtest,
} from './rating.js';
import {
  hpInfo, clutch, leaks, tilt, heatmap, meta, race, records, weekly, scorePreds, calibration, eloPreds, tune, GRID, archetype,
  CLOSE_HP, SESSION_GAP_MIN,
} from './stats.js';

/* ---------- constants ---------- */
const PLACEMENT_HINT = '8';   // battles to get placed the first time (about 3 after each season reset)
const MODES = ['Classic', 'Triple Elixir', 'Draft', 'Sudden Death', 'Mega Deck', 'Other'];
const COLORS = ['#4a90ff', '#ff5367', '#ffc63a', '#3fd68f', '#b783ff', '#ff8a3d', '#2fd3e0', '#ff74be'];
const CROWN = '<svg class="crown" viewBox="0 0 24 20" aria-hidden="true"><path d="M2 6l5 4 5-8 5 8 5-4-2 11H4z"/><rect x="4" y="17" width="16" height="2.5" rx="1"/></svg>';
// Season champion: a medal on a blue/red ribbon (the crown already means #1 and match winner).
const MEDAL = '<svg class="medal" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 1h5l2.2 7.5H8.4z" fill="#4a90ff"/><path d="M18 1h-5l-2.2 7.5h4.8z" fill="#ff5367"/><circle cx="12" cy="15.5" r="7.2" fill="#ffc63a"/><circle cx="12" cy="15.5" r="5.3" fill="none" stroke="#9a6a00" stroke-width="1.2"/><path d="M12 11.6l1.15 2.35 2.6.38-1.88 1.83.44 2.58L12 17.52l-2.31 1.22.44-2.58-1.88-1.83 2.6-.38z" fill="#9a6a00"/></svg>';
// Ladder trophies use the game's own convention: a trophy cup.
const TROPHY = '<svg class="trophy" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 2h10v2h3.5v3.2A4.3 4.3 0 0116.6 11.5 5.3 5.3 0 0113 14.9V18h3.5v3.5h-9V18H11v-3.1a5.3 5.3 0 01-3.6-3.4A4.3 4.3 0 013.5 7.2V4H7zm0 4H5.5v1.2A2.3 2.3 0 007 9.3zm10 0v3.3a2.3 2.3 0 001.5-2.1V6z"/></svg>';
const ICON_OPEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h10v2H4zm0 6h10v2H4zm0 6h7v2H4zm12.6-6.4L20 14l-3.4 3.4-1.4-1.4 1-1H13v-2h3.2l-1-1z"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17.2V20h2.8l8.3-8.3-2.8-2.8zM19.7 7.1a1 1 0 000-1.4l-1.4-1.4a1 1 0 00-1.4 0l-1.6 1.6 2.8 2.8z"/></svg>';
const ICON_DEL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 21a2 2 0 01-2-2V7h14v12a2 2 0 01-2 2zM9 9v9h2V9zm4 0v9h2V9zM15.5 4H19v2H5V4h3.5l1-1h5z"/></svg>';
const PW_KEY = 'crl-password';
const REFRESH_MS = 30000;

/* ---------- state ---------- */
const S = {
  data: { players: {}, matches: {}, league: { name: 'Friendly Battle League' } },
  sync: null,
  editable: false,     // server has a password configured
  unlocked: false,     // this browser knows the password
  loaded: false,
  error: '',
  demo: null,
  filter: '',
  season: '',          // '' = current season, 'all', or 'YYYY-MM'
  tz: 'America/Chicago',
  pa: '', pb: '',      // matchup predictor picks
  matchLimit: 50,
  tune: null,          // last Lab tuning result
  sort: { key: null, dir: 'desc' }, // standings column sort; null = placement
};
const D = () => S.demo || S.data;
const writable = () => !!S.demo || (S.editable && S.unlocked);

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const R = r => Math.round(r);
function fmtD(d) {
  if (d == null) return '';
  const v = Math.round(d);
  if (v === 0) return '±0';
  return (v > 0 ? '+' : '−') + Math.abs(v);
}
const dCls = d => d == null ? 'flat' : Math.round(d) > 0 ? 'up' : Math.round(d) < 0 ? 'down' : 'flat';
const initials = n => (String(n).trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2) || '?').toUpperCase();
function fmtDate(ms, withTime = true) {
  if (!ms) return withTime ? { day: '—', time: '' } : '—';
  const d = new Date(ms);
  const day = (d.getFullYear() === THIS_YEAR ? DAY_FMT : DAY_Y_FMT).format(d);
  return withTime ? { day, time: TIME_FMT.format(d) } : day;
}
// Formatters are built once; toLocaleDateString builds a new one on every call, which adds up over a long match log.
const THIS_YEAR = new Date().getFullYear();
const DAY_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const DAY_Y_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
function ago(ms) {
  if (!ms) return 'never';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function toLocalInput(ms) {
  const d = new Date(ms); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 4500);
}
const getPw = () => { try { return localStorage.getItem(PW_KEY) || ''; } catch { return ''; } };
const setPw = v => { try { v ? localStorage.setItem(PW_KEY, v) : localStorage.removeItem(PW_KEY); } catch { /* storage blocked */ } };

/* ---------- API ---------- */
async function api(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const pw = getPw(); if (pw) headers['X-League-Password'] = pw;
  let res;
  try { res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }); }
  catch { throw new Error("Couldn't reach the server. Check your connection."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && method !== 'GET') { setPw(''); S.unlocked = false; render(); }
    const e = new Error(data.error || `The server returned ${res.status}.`); e.status = res.status; throw e;
  }
  return data;
}
// Decks arrive compact ({cards: [{id, evo}], tower}); fill in names, elixir and icons from the card catalog.
function hydrateDeck(d, cards) {
  if (!d || !Array.isArray(d.cards) || !d.cards.length) return null;
  const info = id => cards[id] || { id, name: 'Unknown card', elixir: null, rarity: '', icon: '', iconEvo: '' };
  return {
    cards: d.cards.map(c => { const k = info(c.id); return { id: c.id, evo: !!c.evo, name: k.name, elixir: k.elixir ?? null, rarity: k.rarity || '', icon: (c.evo && k.iconEvo) || k.icon || '' }; }),
    tower: d.tower ? { id: d.tower, name: info(d.tower).name, icon: info(d.tower).icon || '' } : null,
  };
}
function normalize(payload) {
  const players = {}, matches = {}, cards = {};
  for (const c of payload.cards || []) cards[c.id] = c;
  for (const p of payload.players || []) players[p.id] = p;
  for (const m of payload.matches || []) matches[m.id] = { ...m, deckA: hydrateDeck(m.deckA, cards), deckB: hydrateDeck(m.deckB, cards) };
  return { players, matches, league: payload.league || { name: 'Friendly Battle League' } };
}
async function refresh() {
  try {
    const payload = await api('GET', '/api/league');
    S.data = normalize(payload);
    S.tz = payload.settings?.timezone || 'America/Chicago';
    S.sync = payload.sync;
    S.editable = !!payload.auth?.editable;
    S.loaded = true; S.error = '';
  } catch (e) {
    S.error = S.loaded ? 'Lost connection to the server. Showing the last data loaded.' : e.message;
    S.loaded = S.loaded || false;
  }
  render();
}
async function write(fn, okMsg) {
  try {
    const out = await fn();
    await refresh();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(out) : okMsg);
    return true;
  } catch (e) { toast(e.message); return false; }
}
const ops = {
  putPlayer: (p, isNew) => S.demo ? demoPut('players', p) : write(() => isNew ? api('POST', '/api/players', p) : api('PATCH', `/api/players/${p.id}`, p)),
  delPlayer: id => S.demo ? demoDel('players', id) : write(() => api('DELETE', `/api/players/${id}`)),
  putMatch: (m, isNew) => S.demo ? demoPut('matches', m) : write(() => isNew ? api('POST', '/api/matches', m) : api('PATCH', `/api/matches/${m.id}`, m)),
  delMatch: id => S.demo ? demoDel('matches', id) : write(() => api('DELETE', `/api/matches/${id}`)),
  putLeague: l => S.demo ? (S.demo.league = l, render(), true) : write(() => api('PATCH', '/api/league', l)),
};
function demoPut(coll, obj) {
  if (!obj.id) obj.id = 'demo' + Math.random().toString(36).slice(2, 9);
  if (!obj.createdAt) obj.createdAt = Date.now();
  S.demo[coll][obj.id] = { ...(S.demo[coll][obj.id] || {}), ...obj };
  leagueMemo = null; render(); return Promise.resolve(true);
}
function demoDel(coll, id) { delete S.demo[coll][id]; leagueMemo = null; render(); return Promise.resolve(true); }

/* ---------- small renderers ---------- */
const avatar = (p, lg) => `<span class="av${lg ? ' lg' : ''}" style="background:${esc(p.color)}" aria-hidden="true">${esc(initials(p.name))}</span>`;
const formHtml = f => f.length ? `<span class="form" aria-label="Last ${f.length}: ${f.join(' ')}">${f.map(r => `<i class="${r}">${r}</i>`).join('')}</span>` : '<span class="muted">—</span>';
const streakHtml = s => s.streakN >= 1 && s.streakT ? `<span class="chip streak ${s.streakT}">${s.streakT}${s.streakN}</span>` : '<span class="muted">—</span>';
const fmtPct = p => Math.round(p * 100) + '%';
const champChip = (L, id) => L.champCount[id] ? `<span class="champ" title="${L.champCount[id]}× season champion">${MEDAL}${L.champCount[id] > 1 ? L.champCount[id] + '×' : ''}</span>` : '';
function spark(vals, w = 76, h = 28) {
  if (vals.length < 3) return '<span class="muted">—</span>';
  const v = vals.slice(-15), mn = Math.min(...v), mx = Math.max(...v), span = Math.max(mx - mn, 12), mid = (mx + mn) / 2;
  const pts = v.map((y, i) => [2 + (i / (v.length - 1)) * (w - 6), h / 2 - ((y - mid) / span) * (h - 8)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
  const L = pts[pts.length - 1], up = v[v.length - 1] >= v[0];
  return `<svg class="spark ${up ? 'up' : 'down'}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="RP trend, last ${v.length} rated matches"><path class="sa" d="${d}L${L[0].toFixed(1)} ${h}L2 ${h}Z"/><path class="sl" d="${d}"/><circle cx="${L[0].toFixed(1)}" cy="${L[1].toFixed(1)}" r="2.6"/></svg>`;
}

// SVG charts scale with their box, so on a phone a 760-wide chart shrinks its labels to ~5px.
// Draw a narrower chart there instead (text stays ~10px). render() reruns when the breakpoint flips.
const PHONE_MQ = window.matchMedia('(max-width:560px)');
const narrow = () => PHONE_MQ.matches;

/** RP and skill over every rated game across seasons: the gold line is RP (dashed while unplaced), the thin line the centre of the
 *  skill range, the band the range itself. Scaled so every RP and centre point fits; only the band's upper edge may clip. */
function ratingChart(points) {
  const W = narrow() ? 380 : 640, H = narrow() ? 220 : 240, l = 42, r = 14, t = 14, b = 30;
  if (points.length < 2) return '<p class="muted" style="margin:0">The chart shows up after the first rated match.</p>';
  const rp = p => p.r - 2 * p.rd;
  const vals = points.flatMap(p => [p.r, rp(p)]);
  const mnV = Math.min(...vals), mxV = Math.max(...vals);
  const step = (mxV - mnV) > 400 ? 100 : 50;
  let lo = Math.floor((mnV - 30) / step) * step, hi = Math.ceil((mxV + 30) / step) * step;
  if (hi - lo < step * 3) { lo -= step; hi += step; }
  const n = points.length - 1;
  const x = i => l + (i / n) * (W - l - r);
  const y = v => t + (1 - (v - lo) / (hi - lo)) * (H - t - b);
  let g = '';
  for (let v = lo; v <= hi; v += step) g += `<line class="grid" x1="${l}" x2="${W - r}" y1="${y(v)}" y2="${y(v)}"/><text x="${l - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  const base = START_R > lo && START_R < hi ? `<line class="base" x1="${l}" x2="${W - r}" y1="${y(START_R)}" y2="${y(START_R)}"/>` : '';
  const centre = points.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.r).toFixed(1)).join('');
  // The RP line is split into placed (solid) and unplaced (dashed) runs.
  const seg = (want) => { let d = '', pen = false; points.forEach((p, i) => { const on = (p.rd <= PROVISIONAL_RD) === want; if (on || (pen && i > 0)) d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(rp(p)).toFixed(1); pen = on; }); return d; };
  const upper = points.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.r + 2 * p.rd).toFixed(1)).join('');
  const lower = points.map((p, i) => 'L' + x(n - i).toFixed(1) + ' ' + y(rp(points[n - i])).toFixed(1)).join('');
  const seasons = points.map((p, i) => p.reset ? `<line class="sline" x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${t}" y2="${H - b}"/><text class="slabel" x="${(x(i) + 4).toFixed(1)}" y="${t + 10}">${esc(seasonLabel(p.season, true).split(' ')[0])}</text>` : '').join('');
  const last = points[n];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="RP and skill history over ${n} points, now ${R(rp(last))} RP, skill ${R(rp(last))} to ${R(last.r + 2 * last.rd)}">
    <defs>
      <clipPath id="plot"><rect x="${l}" y="${t}" width="${W - l - r}" height="${H - t - b}"/></clipPath>
    </defs>
    ${g}${base}
    <g clip-path="url(#plot)"><path class="band" d="${upper}${lower}Z"/></g>
    ${seasons}
    <path class="line centre" d="${centre}"/>
    <path class="line rp unplaced" d="${seg(false)}"/>
    <path class="line rp" d="${seg(true)}"/>
    <circle class="end" cx="${x(n).toFixed(1)}" cy="${y(rp(last)).toFixed(1)}" r="5"/>
    <text x="${l}" y="${H - 8}">First battle</text>
    <text x="${W - r}" y="${H - 8}" text-anchor="end">Now · ${R(rp(last))} RP</text>
  </svg>`;
}

/* ---------- cards + decks ---------- */
const RARITY = { common: '#9fb0c8', rare: '#ffa64d', epic: '#c36bff', legendary: '#6ff0ff', champion: '#ffd84d' };
const abbr = name => String(name || '?').split(/[\s.-]+/).filter(Boolean).map(w => w[0]).join('').slice(0, 3).toUpperCase();
function cardTile(c, size = '') {
  const label = `${c.name}${c.evo ? ' (Evolution)' : ''}${Number.isFinite(c.elixir) ? ` · ${c.elixir} elixir` : ''}`;
  if (c.icon) return `<img class="ct${size}${c.evo ? ' evo' : ''}" src="${esc(c.icon)}" alt="${esc(c.name)}" title="${esc(label)}" loading="lazy" decoding="async">`;
  return `<span class="ct txt${size}${c.evo ? ' evo' : ''}" style="--rc:${RARITY[String(c.rarity).toLowerCase()] || RARITY.common}" title="${esc(label)}">${esc(abbr(c.name))}</span>`;
}
function deckHtml(deck, size = '') {
  if (!deck?.cards?.length) return '<span class="nodeck">No deck data</span>';
  const ae = avgElixir(deck);
  return `<span class="deckcards">${deck.cards.map(c => cardTile(c, size)).join('')}</span>${ae != null ? `<span class="elx" title="Average elixir">${ae.toFixed(1)}</span>` : ''}`;
}

function matchRow(m, data, view) {
  const A = data.players[m.a], B = data.players[m.b], dl = view.delta[m.id] || {};
  const when = fmtDate(m.playedAt);
  const tieNote = m.ca === m.cb ? (m.winner === 'draw' ? 'Draw' : 'Tiebreaker') : '';
  const pA = dl.pA;
  const pWin = m.winner === 'a' ? pA : m.winner === 'b' ? 1 - pA : null;
  const upset = m.ranked && pWin != null && pWin < 0.35;
  const hp = hpInfo(m);
  const lA = m.stats?.a?.leaked, lB = m.stats?.b?.leaked;
  const detail = [hp ? `Towers left: ${hp.hpA.toLocaleString()} vs ${hp.hpB.toLocaleString()} HP` : '', Number.isFinite(lA) && Number.isFinite(lB) ? `Elixir leaked: ${lA.toFixed(1)} vs ${lB.toFixed(1)}` : ''].filter(Boolean).join(' · ');
  const side = (p, cls, won, d) => { const mv = moveChip(rankMove(dl, cls)); return `<div class="side ${cls}${won ? ' won' : ''}">
      ${cls === 'b' ? mv : ''}${cls === 'b' && d != null ? `<span class="dl ${dCls(d)}">${fmtD(d)}</span>` : ''}
      ${won && cls === 'b' ? CROWN : ''}
      <a href="#p-${esc(p.id)}">${esc(p.name)}</a>
      ${won && cls === 'a' ? CROWN : ''}
      ${cls === 'a' && d != null ? `<span class="dl ${dCls(d)}">${fmtD(d)}</span>` : ''}${cls === 'a' ? mv : ''}
    </div>`; };
  const acts = `<div class="row-acts">
      <button class="iconbtn" type="button" data-act="details" data-id="${esc(m.id)}" aria-label="Battle details">${ICON_OPEN}</button>
      ${writable() ? `<button class="iconbtn hide-sm" type="button" data-act="edit-match" data-id="${esc(m.id)}" aria-label="Edit match">${ICON_EDIT}</button>
      <button class="iconbtn hide-sm" type="button" data-act="del-match" data-id="${esc(m.id)}" aria-label="Delete match">${ICON_DEL}</button>` : ''}</div>`;
  const decks = (m.deckA || m.deckB) ? `<div class="decks"><div class="deck-strip a">${deckHtml(m.deckA)}</div><div class="deck-strip b">${deckHtml(m.deckB)}</div></div>` : '';
  return `<div class="match" data-match="${esc(m.id)}">
    <div class="when"><b>${esc(when.day)}${m.source === 'api' ? '<span class="auto" title="Imported from the Clash Royale battle log">Auto</span>' : ''}</b>${esc(when.time)} · ${esc(m.mode)}${m.ranked ? '' : ' · <span class="unranked">unrated</span>'}${m.notes ? `<br>${esc(m.notes)}` : ''}</div>
    ${side(A, 'a', m.winner === 'a', dl.rpA)}
    <div class="score-wrap"${detail ? ` title="${esc(detail)}"` : ''}>
      <div class="score num"><span class="a">${m.ca}</span><span class="dash">–</span><span class="b">${m.cb}</span></div>
      ${upset ? `<div class="score-note upset" title="The winner had a ${fmtPct(pWin)} chance before the match">Upset · ${fmtPct(pWin)}</div>` : tieNote ? `<div class="score-note">${tieNote}</div>` : hp?.close ? `<div class="score-note close">Close</div>` : ''}
      ${pA != null && !upset ? `<div class="odds" title="Win chances before the match"><span class="a">${fmtPct(pA)}</span><span class="b">${fmtPct(1 - pA)}</span></div>` : ''}
      ${detail ? `<div class="hpline">${hp ? `${hp.hpA >= hp.hpB ? '+' : '−'}${Math.abs(R0(hp.hpA - hp.hpB)).toLocaleString()} HP` : ''}</div>` : ''}
    </div>
    ${side(B, 'b', m.winner === 'b', dl.rpB)}
    ${acts}
    ${decks}
  </div>`;
}

/* ---------- season bar ---------- */
function daysLeft(L) {
  const d = (L.seasonEndsAt - Date.now()) / 864e5;
  return d < 1 ? 'Ends today' : `${Math.ceil(d)} day${Math.ceil(d) === 1 ? '' : 's'} left`;
}
function seasonBar(L) {
  const sel = S.season || L.currentKey;
  const isAll = sel === 'all', isCur = sel === L.currentKey;
  const note = isAll ? 'Continuous, no season resets' : isCur ? daysLeft(L) : (() => {
    const c = L.champions.find(x => x.key === sel);
    return c ? `Final · champion ${esc(D().players[c.id]?.name || '?')}` : 'Final standings';
  })();
  return `<div class="seasonbar">
    <div class="sb-main"><span class="eyebrow">${isAll ? 'View' : 'Season'}</span><b>${isAll ? 'All time' : esc(seasonLabel(sel))}</b><span class="muted">${note}</span></div>
    <label class="sb-pick"><span class="sr">Choose season</span><select id="seasonSel">
      ${L.seasons.map(k => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(seasonLabel(k))}${k === L.currentKey ? ' (current)' : ''}</option>`).join('')}
      <option value="all"${isAll ? ' selected' : ''}>All time</option>
    </select></label>
  </div>`;
}

/* ---------- views ---------- */
function viewEmpty() {
  return `<section class="panel empty">
    <div class="eyebrow">New league</div>
    <h2>Add your crew, then go play some friendlies</h2>
    <p>Add each friend with their player tag. Every few minutes the server checks everyone's battle log and imports friendlies between league members automatically, decks included, then updates ratings, streaks and rivalries.</p>
    <div class="steps">
      <div><b>1. Add players</b><span>Name plus player tag (in-game: tap your profile, the tag starts with #).</span></div>
      <div><b>2. Play friendlies</b><span>1v1 friendly battles between two league members get picked up on their own.</span></div>
      <div><b>3. Climb</b><span>Monthly seasons crown a champion. You can still log or fix matches by hand.</span></div>
    </div>
    <div class="actions">
      ${writable() ? '<button class="btn primary" type="button" data-act="add-player">Add the first player</button>' : (S.editable ? '<button class="btn primary" type="button" data-act="unlock">Unlock editing</button>' : '')}
      <button class="btn" type="button" data-act="demo-on">Preview with sample data</button>
    </div>
  </section>`;
}
const RP_HELP = 'Ranked Points = the floor of your skill range (rating − 2×RD): the rating the system is about 95% sure you are above. Standings use it, so a hot start with few games can\'t top the table until it holds up.';
const SR_HELP = 'Skill range: where the system thinks your true skill sits (rating ± 2×RD). It narrows as you play and widens while you are away. RP is its lower end.';
const rankChip = (s, extra = '') => { const k = rank(s); return `<span class="chip ${k.cls}${extra}">${k.label}</span>`; };
/** What a battle did to a player's rank: placed them, moved them up or down a division, or nothing. */
function rankMove(dl, side) {
  const rp = dl?.rp; if (!rp) return null;
  const placedAfter = rp[side === 'a' ? 'placedA' : 'placedB'], preRd = side === 'a' ? dl.preRdA : dl.preRdB;
  if (!placedAfter) return null;
  const after = rankOf(rp[side + '1']);
  if (preRd > PROVISIONAL_RD) return { kind: 'placed', to: after };
  const before = rankOf(rp[side + '0']);
  if (after.ord === before.ord) return null;
  return { kind: after.ord > before.ord ? 'up' : 'down', to: after, from: before };
}
const moveChip = (mv, small = true) => (mv ? `<span class="chip rkmove ${mv.kind} ${mv.to.cls}${small ? ' sm' : ''}" title="${mv.kind === 'placed' ? 'Placements done' : mv.kind === 'up' ? `Promoted from ${mv.from.label}` : `Demoted from ${mv.from.label}`}">${mv.kind === 'placed' ? 'Placed · ' : mv.kind === 'up' ? '▲ ' : '▼ '}${mv.to.label}</span>` : '');
const skillRange = s => `${R(s.r - 2 * s.rd)} – ${R(s.r + 2 * s.rd)}`;
// RP cell: the number, the change from the last battle, and the rank underneath.
function ratingCell(s) {
  if (!isPlaced(s)) return `<span class="rating num muted" title="RP shows once placements are done">—</span><span class="rd">${s.games ? 'Placing' : 'No battles yet'}</span>`;
  const d = s.lastScore != null ? `<span class="delta ${dCls(s.lastScore)}">${fmtD(s.lastScore)}</span>` : '';
  return `<span class="rating num" title="${RP_HELP}">${R(s.score)}</span>${d}<span class="rd">${rankChip(s)}</span>`;
}
/* ---------- standings sorting ---------- */
const SORT_KEYS = {
  name: { dir: 'asc', val: (p) => p.name.toLowerCase() },
  rating: { dir: 'desc', val: (p, s) => (isPlaced(s) ? s.score : null) },
  wl: { dir: 'desc', val: (p, s) => s.w * 1000 - s.l },
  pct: { dir: 'desc', val: (p, s) => (s.games ? (s.w + 0.5 * s.d) / s.games : null) },
  cpg: { dir: 'desc', val: (p, s) => (s.games ? s.cf / s.games : null) },
  streak: { dir: 'desc', val: (p, s) => (s.streakT === 'W' ? s.streakN : s.streakT === 'L' ? -s.streakN : 0) },
};
function sortRows(rows, view) {
  const k = S.sort.key, def = SORT_KEYS[k];
  if (k === 'rank') return rows.slice().reverse(); // '#' clicked: worst placement first
  if (!def) return rows;
  const sign = S.sort.dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const va = def.val(a, view.st[a.id]), vb = def.val(b, view.st[b.id]);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;   // unplaced players stay at the bottom either way
    if (vb == null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * sign || rows.indexOf(a) - rows.indexOf(b);
  });
}
function sortTh(key, label, cls = '') {
  const on = S.sort.key === key || (key === 'rank' && !S.sort.key);
  const dir = !on ? null : key === 'rank' ? (S.sort.key === 'rank' ? 'desc' : 'asc') : S.sort.dir;
  const aria = on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const arrow = on ? (dir === 'asc' ? '↑' : '↓') : '';
  return `<th class="sortable ${cls}" aria-sort="${aria}"><button type="button" data-act="sort" data-key="${key}">${label}<span class="sarr" aria-hidden="true">${arrow}</span></button></th>`;
}
// Phones hide most stat columns; the full table opens every column in a sheet with the player column pinned.
const ICON_EXPAND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v2H7.4l3.3 3.3-1.4 1.4L6 7.4V10H4zm10 0h6v6h-2V7.4l-3.3 3.3-1.4-1.4L16.6 6H14zM4 14h2v2.6l3.3-3.3 1.4 1.4L7.4 18H10v2H4zm12.6 4-3.3-3.3 1.4-1.4 3.3 3.3V14h2v6h-6v-2z"/></svg>';
let lastStandings = null;
function pinStandings() {
  const box = dlg.querySelector('.st-full'), first = box?.querySelector('thead th');
  if (first) box.style.setProperty('--c1', first.offsetWidth + 'px');
}
function standingsFull() {
  if (!lastStandings) return;
  openDlg(`Standings <span class="muted st-sub">${esc(lastStandings.title)}</span>`, `<div class="st-full table-wrap">${lastStandings.tbl}</div><p class="muted st-hint">Swipe sideways for more columns. Tap a header to sort.</p>`,
    '<button class="btn primary" type="button" data-act="close">Done</button>',
    form => { form.closest('dialog').classList.add('wide', 'sheet-full'); pinStandings(); });
}
function viewStandings(data, L, view) {
  const all = ranking(data, view);
  if (!Object.keys(data.players).length) return viewEmpty();
  const rows = all.filter(p => isPlaced(view.st[p.id]));
  const unplaced = all.filter(p => !isPlaced(view.st[p.id]));
  const played = all.filter(p => view.st[p.id].games > 0);
  const leader = rows[0];
  let hot = null; for (const p of all) { const s = view.st[p.id]; if (s.streakT === 'W' && s.streakN >= 2 && (!hot || s.streakN > view.st[hot.id].streakN)) hot = p; }
  const pairs = {}; for (const m of view.ms) { const k = [m.a, m.b].sort().join('|'); pairs[k] = (pairs[k] || 0) + 1; }
  let top = null; for (const k in pairs) if (!top || pairs[k] > pairs[top]) top = k;
  const auto = view.ms.filter(m => m.source === 'api').length;
  const strip = `<section class="strip" aria-label="Summary">
    <div><div class="k">Battles</div><div class="v num">${view.ms.length}</div><div class="s">${auto} auto-imported · ${played.length} of ${all.length} players active</div></div>
    <div><div class="k">Leader</div><div class="v">${leader ? esc(leader.name) : '—'}</div><div class="s">${leader ? R(view.st[leader.id].score) + ' RP · ' + rank(view.st[leader.id]).label : played.length ? 'Nobody placed yet' : 'No battles yet'}</div></div>
    <div><div class="k">On fire</div><div class="v">${hot ? esc(hot.name) : '—'}</div><div class="s">${hot ? view.st[hot.id].streakN + ' wins in a row' : 'Nobody on a 2+ win streak'}</div></div>
    <div><div class="k">Biggest rivalry</div><div class="v">${top ? top.split('|').map(id => esc(data.players[id].name)).join(' <span class="muted">vs</span> ') : '—'}</div><div class="s">${top ? pairs[top] + (pairs[top] === 1 ? ' battle' : ' battles') : 'Play a friendly to start one'}</div></div>
  </section>`;
  // Place is fixed by RP; sorting only reorders the rows, each row keeps its place number.
  const place = new Map(rows.map((p, i) => [p.id, i + 1]));
  const shown = sortRows(rows, view);
  const body = shown.map(p => {
    const s = view.st[p.id], rk = place.get(p.id);
    return `<tr class="link" data-href="#p-${esc(p.id)}">
      <td class="rank${rk === 1 ? ' first' : ''}">${rk === 1 ? CROWN : ''}${rk}</td>
      <td><a class="pl" href="#p-${esc(p.id)}">${avatar(p)}<span style="min-width:0"><span class="nm" style="display:block">${esc(p.name)}${champChip(L, p.id)}</span>${p.tag ? `<span class="tag">${esc(p.tag)}</span>` : '<span class="tag">No tag, not auto-tracked</span>'}</span></a></td>
      <td>${ratingCell(s)}</td>
      <td class="num">${s.w}-${s.l}${s.d ? '-' + s.d : ''}</td>
      <td class="num r hide-sm">${pct(s)}</td>
      <td class="num r hide-md c-cpg">${s.games ? (s.cf / s.games).toFixed(1) : '—'}</td>
      <td class="hide-sm c-streak">${streakHtml(s)}</td>
      <td class="hide-md">${formHtml(s.form)}</td>
      <td class="hide-md c-trend">${spark(s.scoreHist)}</td>
    </tr>`;
  }).join('');
  const retired = Object.values(data.players).filter(p => p.archived);
  const champs = L.champions.length ? `<section class="panel">
      <div class="panel-h"><h2>Season champions</h2><span class="muted" style="font-size:13px">Most RP at month's end, ${MIN_CHAMP_GAMES}+ battles</span></div>
      <div class="panel-b champs">${L.champions.map(c => { const p = data.players[c.id]; return p ? `<a class="champcard" href="#p-${esc(p.id)}">${MEDAL}<span class="cs">${esc(seasonLabel(c.key))}</span>${avatar(p)}<span class="cn">${esc(p.name)}</span><span class="cr num" title="Final RP">${R(c.score ?? c.r)} <small>RP</small></span></a>` : ''; }).join('')}</div>
    </section>` : '';
  const tbl = `      <table>
        <thead><tr>${sortTh('rank', '#')}${sortTh('name', 'Player')}${sortTh('rating', 'RP')}${sortTh('wl', 'W-L')}${sortTh('pct', 'Win %', 'r hide-sm')}${sortTh('cpg', 'Crowns/g', 'r hide-md c-cpg')}${sortTh('streak', 'Streak', 'hide-sm c-streak')}<th class="hide-md">Last 5</th><th class="hide-md c-trend">Trend</th></tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  lastStandings = { tbl, title: view.key === 'all' ? 'All time' : seasonLabel(view.key) };
  const table = `<section class="panel">
    <div class="panel-h"><h2>Standings</h2><span class="muted hide-sm" style="font-size:13px">Click a player for their profile</span>${rows.length ? `<button class="btn small st-expand" type="button" data-act="standings-full" aria-label="Open the full standings table">${ICON_EXPAND}Full table</button>` : ''}</div>
    ${rows.length ? `<div class="panel-b table-wrap" style="padding-top:6px">
${tbl}    </div>` : `<div class="panel-b muted" style="padding-top:8px">Nobody is placed yet${L.seasons.length > 1 && view.key !== 'all' ? ' this season' : ''}. The table fills in as players finish their placement battles.</div>`}
    ${unplaced.length ? unplacedHtml(unplaced, view) : ''}
    ${retired.length ? `<div class="panel-b muted" style="padding-top:0;font-size:13.5px">Retired: ${retired.map(p => `<a href="#p-${esc(p.id)}">${esc(p.name)}</a>`).join(', ')}</div>` : ''}
  </section>`;
  // Phones lead with the table itself; the summary tiles follow it.
  return seasonBar(L) + (narrow() ? table + strip : strip + table) + champs;
}
// Players the system isn't sure about yet: no RP, no rank, just how far along their placements are.
function placingProgress(s) {
  const rd0 = s.rdHist[0] ?? 350, span = rd0 - PROVISIONAL_RD;
  return span > 0 ? Math.max(0, Math.min(1, (rd0 - s.rd) / span)) : 1;
}
function unplacedHtml(list, view) {
  return `<div class="unplaced">
    <div class="unplaced-h"><span>Unplaced</span><span class="muted">RP and rank show after placements: about ${PLACEMENT_HINT} battles at first, 3 each new season</span></div>
    ${list.map(p => { const s = view.st[p.id], pr = placingProgress(s); return `<a class="unplaced-row" href="#p-${esc(p.id)}">
      ${avatar(p)}<span class="un-name"><span class="nm">${esc(p.name)}</span><span class="tag">${s.games ? `${s.games} ${s.games === 1 ? 'battle' : 'battles'} · ${s.w}-${s.l}${s.d ? '-' + s.d : ''}` : 'No battles yet'}</span></span>
      <span class="un-prog" title="Placement progress"><i style="width:${Math.round(pr * 100)}%"></i></span><span class="un-pct num">${s.games ? Math.round(pr * 100) + '%' : ''}</span>
    </a>`; }).join('')}
  </div>`;
}
function viewMatches(data, L, view) {
  const players = Object.values(data.players).sort((a, b) => a.name.localeCompare(b.name));
  if (!players.length) return viewEmpty();
  if (S.filter && !data.players[S.filter]) S.filter = '';
  const list = view.ms.filter(m => !S.filter || m.a === S.filter || m.b === S.filter).slice().reverse();
  const shown = list.slice(0, S.matchLimit);
  return seasonBar(L) + `<section class="panel">
    <div class="panel-h"><h2>Match log</h2>
      <div class="filters"><label for="filterSel" class="muted" style="font-size:13px">Show</label>
        <select id="filterSel"><option value="">All players</option>${players.map(p => `<option value="${esc(p.id)}"${S.filter === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      </div>
    </div>
    <div class="panel-b">
      ${shown.length ? `<div class="mlist">${shown.map(m => matchRow(m, data, view)).join('')}</div>
        ${list.length > shown.length ? `<div style="text-align:center;padding-top:12px"><button class="btn small" type="button" data-act="more">Show ${Math.min(50, list.length - shown.length)} more of ${list.length - shown.length}</button></div>` : ''}` :
        `<p class="muted" style="margin:6px 0 0">No battles in this season${S.filter ? ' for this player' : ''} yet. Friendlies between tagged players show up here automatically.</p>`}
    </div>
  </section>`;
}
/* ---------- rivalry ---------- */
const pairHash = (a, b) => `#r-${a}-${b}`;
// Swap a match's sides (and its deltas) so a given player is always on the blue/left side.
const SWAP_W = { a: 'b', b: 'a', draw: 'draw' };
function flipMatch(m) {
  return { ...m, a: m.b, b: m.a, ca: m.cb, cb: m.ca, winner: SWAP_W[m.winner] || m.winner, deckA: m.deckB, deckB: m.deckA,
    stats: m.stats ? { a: m.stats.b, b: m.stats.a } : m.stats };
}
const flipDelta = d => (d ? { ...d, a: d.b, b: d.a, preA: d.preB, preB: d.preA, preRdA: d.preRdB, preRdB: d.preRdA, rpA: d.rpB, rpB: d.rpA, rp: d.rp && { a0: d.rp.b0, a1: d.rp.b1, b0: d.rp.a0, b1: d.rp.a1, placedA: d.rp.placedB, placedB: d.rp.placedA }, pA: d.pA == null ? d.pA : 1 - d.pA } : d);
/** Resolve "#r-<a>-<b>" against real player ids (ids may themselves contain hyphens). */
function resolvePair(raw, players) {
  for (let i = raw.indexOf('-'); i > 0; i = raw.indexOf('-', i + 1)) {
    const a = raw.slice(0, i), b = raw.slice(i + 1);
    if (players[a] && players[b] && a !== b) return [a, b];
  }
  return null;
}
function momentumChart(data, A, B, ms) {
  if (ms.length < 2) return '';
  const W = narrow() ? 380 : 760, H = narrow() ? 180 : 200, l = 34, r = 12, t = 16, b = 26;
  let run = 0; const pts = [0];
  for (const m of ms) { const aSide = m.a === A.id ? 'a' : 'b'; run += m.winner === 'draw' ? 0 : m.winner === aSide ? 1 : -1; pts.push(run); }
  const mx = Math.max(2, ...pts.map(Math.abs));
  const x = i => l + 8 + (i / (pts.length - 1)) * (W - l - r - 16), y = v => t + (1 - (v + mx) / (2 * mx)) * (H - t - b);
  const d = pts.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join('');
  const dots = pts.length <= 60 ? pts.slice(1).map((v, i) => `<circle class="mdot" cx="${x(i + 1).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3"/>`).join('') : '';
  const lead = pts[pts.length - 1];
  return `<svg class="chart momentum" viewBox="0 0 ${W} ${H}" role="img" aria-label="Running series lead: ${lead === 0 ? 'level' : (lead > 0 ? esc(A.name) : esc(B.name)) + ' up ' + Math.abs(lead)}">
    <rect x="${l}" y="${t}" width="${W - l - r}" height="${(y(0) - t).toFixed(1)}" style="fill:${esc(A.color)}" opacity=".07"/>
    <rect x="${l}" y="${y(0).toFixed(1)}" width="${W - l - r}" height="${(H - b - y(0)).toFixed(1)}" style="fill:${esc(B.color)}" opacity=".07"/>
    <line class="base" x1="${l}" x2="${W - r}" y1="${y(0)}" y2="${y(0)}"/>
    <text x="${l - 6}" y="${t + 10}" text-anchor="end">+${mx}</text><text x="${l - 6}" y="${H - b}" text-anchor="end">−${mx}</text>
    <text x="${l + 6}" y="${t + 12}" style="fill:${esc(A.color)}">${esc(A.name)} ahead</text>
    <text x="${l + 6}" y="${H - b - 6}" style="fill:${esc(B.color)}">${esc(B.name)} ahead</text>
    <path class="line" d="${d}"/>${dots}
    <circle class="end" cx="${x(pts.length - 1).toFixed(1)}" cy="${y(lead).toFixed(1)}" r="5"/>
    <text x="${W - r}" y="${H - 6}" text-anchor="end">Battle ${ms.length}</text><text x="${l}" y="${H - 6}">First meeting</text>
  </svg>`;
}
function rivalryPanel(data, L, view) {
  const active = ranking(data, L.all).filter(p => L.all.st[p.id].games > 0);
  if (active.length < 2) return '';
  if (!data.players[S.pa] || data.players[S.pa].archived) S.pa = active[0].id;
  if (!data.players[S.pb] || data.players[S.pb].archived || S.pb === S.pa) S.pb = active.find(p => p.id !== S.pa).id;
  const A = data.players[S.pa], B = data.players[S.pb];
  const la = L.live[A.id], lb = L.live[B.id];
  const p = winProb(la, lb);
  const opts = sel => active.map(x => `<option value="${esc(x.id)}"${x.id === sel ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
  const all = L.all.ms.filter(m => (m.a === A.id && m.b === B.id) || (m.a === B.id && m.b === A.id));
  const deltas = {}; for (const k in L.byKey) Object.assign(deltas, L.byKey[k].delta);
  const tally = list => {
    const o = { n: 0, w: 0, l: 0, d: 0, cA: 0, cB: 0, threeA: 0, threeB: 0, close: { n: 0, w: 0, l: 0, d: 0 }, swing: 0, hpN: 0 };
    for (const m of list) {
      const aSide = m.a === A.id ? 'a' : 'b', bSide = aSide === 'a' ? 'b' : 'a';
      const res = m.winner === 'draw' ? 'd' : m.winner === aSide ? 'w' : 'l';
      o.n++; o[res]++;
      const ca = aSide === 'a' ? m.ca : m.cb, cb = aSide === 'a' ? m.cb : m.ca;
      o.cA += ca; o.cB += cb;
      if (res === 'w' && ca === 3) o.threeA++; if (res === 'l' && cb === 3) o.threeB++;
      const h = hpInfo(m); if (h) o.hpN++; if (h?.close) { o.close.n++; o.close[res]++; }
      const dl = deltas[m.id]; const rd = dl && (aSide === 'a' ? dl.rpA : dl.rpB); if (rd != null) o.swing += rd;
    }
    return o;
  };
  const tA = tally(all);
  const seasonKeyNow = S.season === 'all' ? null : (S.season || L.currentKey);
  const tS = seasonKeyNow ? tally(all.filter(m => seasonKey(m.playedAt, tz()) === seasonKeyNow)) : null;
  const rec = o => `${o.w}-${o.l}${o.d ? '-' + o.d : ''}`;
  // Deck matchups: A's deck type vs B's deck type
  const mu = new Map();
  for (const m of all) {
    const aSide = m.a === A.id ? 'a' : 'b';
    const da = aSide === 'a' ? m.deckA : m.deckB, db = aSide === 'a' ? m.deckB : m.deckA;
    if (!da?.cards?.length || !db?.cards?.length) continue;
    const k = archetype(da) + '|' + archetype(db);
    const o = mu.get(k) || { a: archetype(da), b: archetype(db), n: 0, w: 0, l: 0, d: 0 };
    o.n++; o[m.winner === 'draw' ? 'd' : m.winner === aSide ? 'w' : 'l']++; mu.set(k, o);
  }
  const mus = [...mu.values()].sort((x, y) => y.n - x.n).slice(0, 8);
  const shown = all.slice().reverse().slice(0, S.matchLimit)
    .map(m => (m.a === A.id ? [m, deltas[m.id]] : [flipMatch(m), flipDelta(deltas[m.id])]));
  const view0 = { delta: Object.fromEntries(shown.map(([m, d]) => [m.id, d])) };
  const lead = tA.w - tA.l;
  return `<section class="panel rivalry">
    <div class="panel-h"><h2>Rivalry</h2><span class="muted" style="font-size:13px">Pick any two players. Tap a cell in the table below to jump here.</span></div>
    <div class="panel-b">
      <div class="predict">
        <div class="pside a"><select id="predA" aria-label="Blue side player">${opts(S.pa)}</select><span class="pr num" title="${SR_HELP}">${skillRange(la)}</span></div>
        <div class="pvs">VS</div>
        <div class="pside b"><select id="predB" aria-label="Red side player">${opts(S.pb)}</select><span class="pr num" title="${SR_HELP}">${skillRange(lb)}</span></div>
      </div>
      <div class="pbar" role="img" aria-label="Next game: ${esc(A.name)} ${fmtPct(p)}, ${esc(B.name)} ${fmtPct(1 - p)}">
        <div class="pa" style="width:${(p * 100).toFixed(1)}%"><span>${fmtPct(p)}</span></div>
        <div class="pb"><span>${fmtPct(1 - p)}</span></div>
      </div>
      <p class="muted chart-note" style="margin-top:6px">Chance to win the next game, from both skill ranges.</p>
      ${tA.n ? `<div class="rv-tiles">
        <div><div class="k">All time</div><div class="v num">${rec(tA)}</div><div class="s">${lead === 0 ? 'Dead even' : `${esc(lead > 0 ? A.name : B.name)} leads by ${Math.abs(lead)}`}</div></div>
        ${tS ? `<div><div class="k">${esc(seasonLabel(seasonKeyNow, true))}</div><div class="v num">${tS.n ? rec(tS) : '—'}</div><div class="s">${tS.n} battle${tS.n === 1 ? '' : 's'} this season</div></div>` : ''}
        <div><div class="k">Crowns</div><div class="v num">${tA.cA}–${tA.cB}</div><div class="s">3-crowns: ${tA.threeA}–${tA.threeB}</div></div>
        <div><div class="k">Close games</div><div class="v num">${tA.close.n ? rec(tA.close) : '—'}</div><div class="s">${tA.close.n ? `${tA.close.n} decided by a hair` : tA.hpN ? 'None yet' : 'No tower HP data yet'}</div></div>
        <div><div class="k">RP swapped</div><div class="v num ${dCls(tA.swing)}">${fmtD(tA.swing)}</div><div class="s">for ${esc(A.name)} across the series</div></div>
      </div>
      <h3 class="sub" style="margin-top:18px">Series momentum</h3>
      ${momentumChart(data, A, B, all) || '<p class="muted" style="margin:0">Needs at least 2 battles.</p>'}
      ${mus.length ? `<h3 class="sub" style="margin-top:18px">Deck matchups</h3>
        <ul class="mu-list" aria-label="Deck matchups">${mus.map(o => `<li><span class="mu-d"><b>${esc(o.a)}</b> <span class="muted">vs</span> ${esc(o.b)}</span><span class="mu-r num ${o.w > o.l ? 'up' : o.w < o.l ? 'down' : ''}">${rec(o)}</span></li>`).join('')}</ul>
        <div class="table-wrap mu-table"><table class="compact"><thead><tr><th>${esc(A.name)} played</th><th>${esc(B.name)} played</th><th class="r">Battles</th><th class="r">${esc(A.name)}</th></tr></thead><tbody>
        ${mus.map(o => `<tr><td class="wrap"><b>${esc(o.a)}</b></td><td class="wrap">${esc(o.b)}</td><td class="num r">${o.n}</td><td class="num r ${o.w > o.l ? 'up' : o.w < o.l ? 'down' : ''}">${rec(o)}</td></tr>`).join('')}
        </tbody></table></div>` : ''}
      <h3 class="sub" style="margin-top:18px">Every battle (${all.length})</h3>
      <div class="mlist">${shown.map(([m]) => matchRow(m, data, view0)).join('')}</div>
      ${all.length > shown.length ? `<div style="text-align:center;padding-top:12px"><button class="btn small" type="button" data-act="more">Show ${Math.min(50, all.length - shown.length)} more</button></div>` : ''}`
    : `<p class="muted" style="margin:14px 0 0">${esc(A.name)} and ${esc(B.name)} haven't battled yet.</p>`}
    </div>
  </section>`;
}
function viewRivalries(data, L, view) {
  const r = route();
  if (r.pair) { const pr = resolvePair(r.pair, data.players); if (pr) { S.pa = pr[0]; S.pb = pr[1]; } }
  const rows = ranking(data, view).filter(p => view.st[p.id].games > 0);
  let matrix;
  if (rows.length < 2) matrix = `<section class="panel"><div class="panel-h"><h2>Head to head</h2></div><div class="panel-b"><p class="muted" style="margin:0">Head-to-head records appear once at least two players have battled this season.</p></div></section>`;
  else {
    const head = rows.map(p => `<th title="${esc(p.name)}">${avatar(p)}</th>`).join('');
    const body = rows.map(r2 => `<tr><th class="rowh"><a class="pl" href="#p-${esc(r2.id)}" title="${esc(r2.name)}">${avatar(r2)}<span class="nm">${esc(r2.name)}</span></a></th>${rows.map(c => {
      if (c.id === r2.id) return '<td class="self">·</td>';
      const h = view.st[r2.id].h2h[c.id];
      if (!h) return '<td class="muted">—</td>';
      const share = (h.w + 0.5 * h.d) / h.n;
      const bg = share > .5 ? `rgba(63,214,143,${(.12 + (share - .5) * .7).toFixed(2)})` : share < .5 ? `rgba(242,123,139,${(.12 + (.5 - share) * .7).toFixed(2)})` : 'rgba(154,166,201,.15)';
      const on = (S.pa === r2.id && S.pb === c.id);
      return `<td class="cell num${on ? ' on' : ''}" style="background:${bg}"><a href="${pairHash(r2.id, c.id)}" title="${esc(r2.name)} vs ${esc(c.name)}: ${h.w}W ${h.l}L${h.d ? ' ' + h.d + 'D' : ''}. Open rivalry.">${h.w}-${h.l}${h.d ? '-' + h.d : ''}</a></td>`;
    }).join('')}</tr>`).join('');
    matrix = `<section class="panel">
      <div class="panel-h"><h2>Head to head</h2><span class="muted" style="font-size:13px">Row player's record against each column player. Tap a cell for the rivalry.</span></div>
      <div class="panel-b table-wrap"><table class="matrix"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div>
    </section>`;
  }
  return seasonBar(L) + rivalryPanel(data, L, view) + matrix;
}

/* ---------- match detail sheet ---------- */
// A tower's full HP depends on the player's level, so use the highest value we've seen for that player.
function towerMax(pid, data) {
  let king = 0, princess = 0;
  for (const m of Object.values(data.matches)) {
    for (const side of ['a', 'b']) {
      if (m[side] !== pid || !m.stats?.[side]) continue;
      const st = m.stats[side];
      if (Number.isFinite(st.king)) king = Math.max(king, st.king);
      for (const v of st.princess || []) princess = Math.max(princess, v);
    }
  }
  return { king: king || 4824, princess: princess || 3052 };
}
function towersHtml(side, crownsAgainst, max) {
  if (!side) return '<p class="muted" style="margin:0">No tower data.</p>';
  const kingDown = crownsAgainst >= 3;
  if (!kingDown && side.king == null) return '<p class="muted" style="margin:0">No tower data.</p>';
  const standing = kingDown ? [] : (side.princess || []);
  const princesses = [...standing, ...Array(Math.max(0, 2 - standing.length)).fill(null)];
  const bar = (label, v, mx) => `<div class="tw"><span class="tl">${label}</span><span class="hbar"><i style="width:${v == null ? 0 : Math.max(2, Math.min(100, 100 * v / mx)).toFixed(1)}%"></i></span><span class="tv num">${v == null ? '<span class="down">Destroyed</span>' : v.toLocaleString()}</span></div>`;
  return bar('King', kingDown ? null : side.king, max.king) + princesses.map(v => bar('Princess', v, max.princess)).join('');
}
function matchDetail(id) {
  const data = D(), m = data.matches[id]; if (!m) return;
  const L = league(data);
  const k = seasonKey(m.playedAt, tz()), dl = L.byKey[k]?.delta[m.id] || {};
  const A = data.players[m.a], B = data.players[m.b]; if (!A || !B) return;
  const hp = hpInfo(m), when = fmtDate(m.playedAt);
  const pA = dl.pA;
  const pWin = m.winner === 'a' ? pA : m.winner === 'b' ? 1 - pA : null;
  const tags = [
    m.source === 'api' ? '<span class="auto">Auto</span>' : '<span class="chip">Logged by hand</span>',
    m.winner === 'draw' ? '<span class="chip">Draw</span>' : m.ca === m.cb ? '<span class="chip">Tiebreaker</span>' : '',
    m.ranked && pWin != null && pWin < 0.35 ? `<span class="chip upchip">Upset · ${fmtPct(pWin)}</span>` : '',
    hp?.close ? '<span class="chip closechip">Close</span>' : '',
    m.ranked ? '' : '<span class="chip">Unrated</span>',
  ].filter(Boolean).join('');
  // RP before → after, or "placing" while the system is still unsure; the skill change sits underneath in small print.
  const side = (p, s, crowns, won, d, prob) => { const rp = dl.rp, rpd = s === 'a' ? dl.rpA : dl.rpB; return `<div class="md-side ${s}${won ? ' won' : ''}">
      <a class="md-name" href="#p-${esc(p.id)}" data-act="close-nav">${avatar(p)}<b>${esc(p.name)}</b>${won ? CROWN : ''}</a>
      <div class="md-crowns">${[1, 2, 3].map(i => `<span class="${i <= crowns ? 'on' : ''}">${CROWN}</span>`).join('')}</div>
      ${prob != null ? `<div class="md-odds">${fmtPct(prob)} to win</div>` : ''}
      ${rpd != null ? `<div class="md-rating num"><span>${R(rp[s + '0'])} → ${R(rp[s + '1'])}</span> <span class="${dCls(rpd)}">${fmtD(rpd)} RP</span></div>` : d != null ? '<div class="md-rating muted">Placing</div>' : m.ranked ? '' : '<div class="md-rating muted">Unrated</div>'}
      ${d != null ? `<div class="md-skill muted num" title="${SR_HELP}">skill ${fmtD(d)}</div>` : ''}
      ${moveChip(rankMove(dl, s), false) ? `<div class="md-move">${moveChip(rankMove(dl, s), false)}</div>` : ''}
    </div>`; };
  const lk = s => m.stats?.[s]?.leaked;
  const lA = lk('a'), lB = lk('b'), lMax = Math.max(5, lA || 0, lB || 0);
  const leakRow = (p, v, s) => `<div class="tw"><span class="tl">${esc(p.name)}</span><span class="hbar leak"><i style="width:${v == null ? 0 : (100 * v / lMax).toFixed(1)}%"></i></span><span class="tv num">${v == null ? '—' : v.toFixed(1)}</span></div>`;
  const deckBlock = (p, deck) => `<div class="md-deck"><div class="md-dh"><b>${esc(p.name)}</b>${deck?.cards?.length ? `<span class="muted">${esc(archetype(deck))}${deck.tower ? ` · ${esc(deck.tower.name)}` : ''}</span>` : ''}</div><div class="deck-strip">${deckHtml(deck, ' md')}</div></div>`;
  const body = `
    <div class="md-top"><span class="muted">${esc(when.day)}, ${esc(when.time)} · ${esc(m.mode)}</span><span class="md-tags">${tags}</span></div>
    <div class="md-board">
      ${side(A, 'a', m.ca, m.winner === 'a', dl.a, pA)}
      <div class="md-score num"><span class="a">${m.ca}</span><span class="dash">–</span><span class="b">${m.cb}</span></div>
      ${side(B, 'b', m.cb, m.winner === 'b', dl.b, pA == null ? null : 1 - pA)}
    </div>
    ${m.stats ? `<div class="md-grid">
      <div><h4 class="sub">${esc(A.name)}'s towers</h4>${towersHtml(m.stats.a, m.cb, towerMax(A.id, data))}</div>
      <div><h4 class="sub">${esc(B.name)}'s towers</h4>${towersHtml(m.stats.b, m.ca, towerMax(B.id, data))}</div>
    </div>
    ${hp ? `<p class="muted chart-note">${m.winner === 'draw' ? 'Tower HP difference' : 'Winner finished'} <b class="${hp.margin >= 0 ? 'up' : 'down'}">${hp.margin >= 0 ? '+' : '−'}${Math.abs(R0(hp.margin)).toLocaleString()} HP</b> ${m.winner === 'draw' ? '' : 'ahead'}${hp.close ? ' (close game)' : ''}.</p>` : ''}
    ${lA != null || lB != null ? `<h4 class="sub">Elixir leaked</h4><div class="md-leak">${leakRow(A, lA)}${leakRow(B, lB)}</div>` : ''}` : '<p class="muted" style="margin:0">No tower or elixir data: this battle was logged by hand.</p>'}
    ${m.deckA || m.deckB ? `<h4 class="sub">Decks</h4>${deckBlock(A, m.deckA)}${deckBlock(B, m.deckB)}` : ''}
    ${m.notes ? `<div class="deck" style="margin:12px 0 0"><b>Notes</b>${esc(m.notes)}</div>` : ''}`;
  const foot = `<a class="btn" href="${pairHash(A.id, B.id)}" data-act="close-nav">Rivalry: ${esc(A.name)} vs ${esc(B.name)}</a>
    ${writable() ? `<button class="btn" type="button" data-act="edit-match" data-id="${esc(m.id)}">Edit</button><button class="btn danger" type="button" data-act="del-match" data-id="${esc(m.id)}">Delete</button>` : ''}
    <button class="btn primary" type="button" data-act="close">Done</button>`;
  openDlg('Battle details', body, foot, form => { form.closest('dialog').classList.add('wide'); });
}

function cardsSection(id, data, view) {
  const cs = cardStats(id, view.ms);
  if (!cs.games) return `<section class="panel"><div class="panel-h"><h2>Decks and cards</h2></div><div class="panel-b"><p class="muted" style="margin:0">No deck data ${S.season === 'all' ? '' : 'this season '}yet. Decks are captured from auto-imported battles, so this fills in as you play friendlies.</p></div></section>`;
  const minN = cs.games >= 15 ? 3 : 2;
  const vs = cs.vs.filter(v => v.n >= minN);
  const worst = vs.slice().sort((a, b) => a.rate - b.rate || b.n - a.n).filter(v => v.rate < 0.5).slice(0, 5);
  const best = vs.slice().sort((a, b) => b.rate - a.rate || b.n - a.n).filter(v => v.rate > 0.5).slice(0, 5);
  const rec = o => `${o.w}-${o.l}${o.d ? '-' + o.d : ''}`;
  const matchup = (list, empty) => list.length ? list.map(v => `<li>${cardTile(v.card, ' sm')}<span class="mn">${esc(v.card.name)}</span><span class="muted num">${rec(v)}</span><span class="num ${v.rate >= 0.5 ? 'up' : 'down'}">${fmtPct(v.rate)}</span></li>`).join('') : `<li class="muted">${empty}</li>`;
  return `<section class="panel">
    <div class="panel-h"><h2>Decks and cards</h2><span class="muted" style="font-size:13px">From ${cs.games} battle${cs.games === 1 ? '' : 's'} with deck data</span></div>
    <div class="panel-b cards-b">
      <div class="godecks">
        <h3 class="sub">Go-to decks</h3>
        ${cs.decks.slice(0, 3).map(d => `<div class="godeck"><div class="deck-strip">${deckHtml(d.deck, ' md')}</div><div class="gd-meta"><b class="num">${d.n}</b> battle${d.n === 1 ? '' : 's'} · <span class="num">${rec(d)}</span> · <span class="num ${d.rate >= 0.5 ? 'up' : 'down'}">${fmtPct(d.rate)}</span></div></div>`).join('')}
      </div>
      <div class="cardcols">
        <div>
          <h3 class="sub">Most used cards</h3>
          <table class="ctable"><thead><tr><th>Card</th><th class="r">Used</th><th class="r">Win %</th></tr></thead><tbody>
          ${cs.cards.slice(0, 10).map(c => `<tr><td><span class="cname">${cardTile(c.card, ' sm')}<span>${esc(c.card.name)}${c.card.evo ? ' <span class="evotag">Evo</span>' : ''}</span></span></td>
            <td class="r"><span class="usebar"><i style="width:${Math.round(100 * c.n / cs.games)}%"></i></span><span class="num">${Math.round(100 * c.n / cs.games)}%</span></td>
            <td class="r num ${c.rate >= 0.5 ? 'up' : 'down'}">${fmtPct(c.rate)}</td></tr>`).join('')}
          </tbody></table>
        </div>
        <div>
          <h3 class="sub">Struggles against</h3>
          <ul class="mups">${matchup(worst, `Nothing yet with ${minN}+ battles against it.`)}</ul>
          <h3 class="sub" style="margin-top:14px">Feasts on</h3>
          <ul class="mups">${matchup(best, `Nothing yet with ${minN}+ battles against it.`)}</ul>
        </div>
      </div>
    </div>
  </section>`;
}
// Ladder trophies live only here, kept small: the league is about RP.
function ladderChip(p) {
  const t = p.ladder?.trophies;
  if (!Number.isFinite(t)) return '';
  const best = Number.isFinite(p.ladder.best) ? ` · best ${p.ladder.best.toLocaleString()}` : '';
  return `<span class="ladder" title="Ladder trophies outside the league${best} · updated ${ago(p.ladder.at)}">${TROPHY}<span class="num">${t.toLocaleString()}</span></span>`;
}
function viewPlayer(id, data, L, view) {
  const p = data.players[id];
  if (!p) return `<section class="panel"><div class="panel-b"><p style="margin:0">That player isn't in this league. <a href="#standings">Back to standings</a></p></div></section>`;
  const s = view.st[id], k = rank(s), placed = isPlaced(s);
  const order = ranking(data, view).filter(x => isPlaced(view.st[x.id])); const pos = order.findIndex(x => x.id === id);
  const rankTxt = p.archived ? 'Retired' : placed ? `#${pos + 1} of ${order.length}` : s.games ? `Placing · ${s.games} of ~${PLACEMENT_HINT} battles` : 'No battles this season';
  const mine = view.ms.filter(m => m.a === id || m.b === id);
  let best = null;
  for (const m of mine) {
    const isA = m.a === id, won = m.winner === (isA ? 'a' : 'b');
    if (!won) continue;
    const opp = view.delta[m.id][isA ? 'preB' : 'preA'];
    if (!best || opp > best.r) best = { r: opp, oppId: isA ? m.b : m.a };
  }
  const titles = L.champions.filter(c => c.id === id);
  // Highest rank ever reached, shown when it beats what this view shows.
  const allPeak = Math.max(L.all.st[id]?.peakScore ?? -Infinity, ...L.seasons.map(sk => L.byKey[sk]?.st[id]?.peakScore ?? -Infinity));
  const bestEver = L.all.st[id]?.games && (!placed || rankOf(allPeak).ord > rankOf(s.peakScore).ord) && isFinite(allPeak) && allPeak >= RANKS[0].min ? rankOf(allPeak) : null;
  const pcl = clutch(data, view).find(r => r.id === id), plk = leaks(data, view).find(r => r.id === id);
  const h2h = Object.entries(s.h2h).sort((a, b) => b[1].n - a[1].n);
  const w = writable();
  // Season resets before the first battle aren't history; the chart starts at the first game.
  const tl = L.timeline[id] || [], firstGame = tl.findIndex(x => !x.reset);
  const chartPts = firstGame < 0 ? [] : tl.slice(firstGame);
  return `<a class="back" href="#standings">← Standings</a>
  ${seasonBar(L)}
  <section class="panel">
    <div class="hero">
      ${avatar(p, true)}
      <div class="who">
        <h2>${esc(p.name)}</h2>
        <div class="meta"><span class="chip ${k.cls}">${k.label}</span><span class="mi">${rankTxt}</span>${p.tag ? `<span class="chip track on" title="Battles are imported automatically from this tag's battle log">${esc(p.tag)} · auto-tracked</span>` : '<span class="chip track">No tag, not auto-tracked</span>'}${ladderChip(p)}<span class="mi">Joined ${esc(fmtDate(p.createdAt, false))}</span></div>
        ${titles.length ? `<div class="titles">${titles.map(c => `<span class="title-chip">${MEDAL}${esc(seasonLabel(c.key))} champion</span>`).join('')}</div>` : ''}
      </div>
      <div class="big"><div class="k" title="${RP_HELP}">Ranked Points</div><div class="rating num${placed ? '' : ' muted'}">${placed ? R(s.score) : '—'}</div>
        <div class="muted" style="font-size:13px">${placed ? (s.lastScore != null ? `Last battle <span class="${dCls(s.lastScore)}">${fmtD(s.lastScore)}</span>` : 'No change yet') : s.games ? 'Shown once placed' : 'Play a friendly to start'}</div>
        <div class="muted srange" title="${SR_HELP}">Skill range <b class="num">${skillRange(s)}</b><span class="hide-sm"> · centre ${R(s.r)}</span></div></div>
      ${w ? `<div class="tools">
        <button class="btn small" type="button" data-act="log" data-id="${esc(id)}">Log a match</button>
        <button class="btn small" type="button" data-act="edit-player" data-id="${esc(id)}">Edit profile</button>
        ${p.archived ? `<button class="btn small" type="button" data-act="restore" data-id="${esc(id)}">Bring back</button>` : `<button class="btn small danger" type="button" data-act="retire" data-id="${esc(id)}">Retire</button>`}
        ${L.all.st[id].games === 0 ? `<button class="btn small danger" type="button" data-act="del-player" data-id="${esc(id)}">Delete</button>` : ''}
      </div>` : ''}
    </div>
    ${p.deck ? `<div class="deck"><b>Main deck</b>${esc(p.deck)}</div>` : ''}
    <div class="stats">
      <div><div class="k">Record</div><div class="v num">${s.w}-${s.l}${s.d ? '-' + s.d : ''}</div></div>
      <div><div class="k">Win rate</div><div class="v num">${pct(s)}</div></div>
      <div><div class="k">Crowns / game</div><div class="v num">${s.games ? (s.cf / s.games).toFixed(1) : '—'}<span class="muted" style="font-size:14px"> vs ${s.games ? (s.ca / s.games).toFixed(1) : '—'}</span></div></div>
      <div><div class="k">3-crown wins</div><div class="v num">${s.three}</div></div>
      <div><div class="k">Streak</div><div class="v">${s.streakT ? `<span class="${s.streakT === 'W' ? 'up' : 'down'}">${s.streakT}${s.streakN}</span>` : '—'}</div></div>
      <div><div class="k">Best streak</div><div class="v num">${s.best ? 'W' + s.best : '—'}</div></div>
      <div><div class="k" title="Draws, tiebreakers and 1-crown games won by ${CLOSE_HP.toLocaleString()} HP or less">Close games</div><div class="v num">${pcl && pcl.close.n ? rec3(pcl.close) : '—'}</div></div>
      <div><div class="k" title="Average remaining tower HP minus the opponent's">HP edge</div><div class="v num ${pcl ? (pcl.avgMargin >= 0 ? 'up' : 'down') : ''}">${pcl ? (pcl.avgMargin >= 0 ? '+' : '−') + Math.abs(R0(pcl.avgMargin)).toLocaleString() : '—'}</div></div>
      <div><div class="k">Elixir leaked</div><div class="v num">${plk ? plk.avg.toFixed(1) : '—'}<span class="muted" style="font-size:14px">${plk ? ' / game' : ''}</span></div></div>
    </div>
  </section>
  <div class="grid2">
    <section class="panel">
      <div class="panel-h"><h2>RP and skill history</h2>${placed ? `<span class="muted" style="font-size:13px">Peak <b class="num">${R(s.peakScore)}</b> RP · ${rankOf(s.peakScore).label}${bestEver ? ` · all-time best <span class="chip ${bestEver.cls}">${bestEver.label}</span>` : ''}</span>` : bestEver ? `<span class="muted" style="font-size:13px">All-time best <span class="chip ${bestEver.cls}">${bestEver.label}</span></span>` : ''}</div>
      <div class="panel-b">${ratingChart(chartPts)}<p class="muted chart-note"><span class="lg rp"></span>RP, dashed while unplaced · <span class="lg band"></span>skill range with its centre line · vertical dashes are season resets.${best ? ` Best win: ${esc(data.players[best.oppId].name)} at ${R(best.r)} skill.` : ''}</p></div>
    </section>
    <section class="panel">
      <div class="panel-h"><h2>Head to head</h2></div>
      <div class="panel-b table-wrap">${h2h.length ? `<table class="compact h2h"><thead><tr><th>Opponent</th><th>W-L</th><th class="r hide-lg">Crowns</th><th class="r" title="RP won or lost against this opponent, placement games excluded">RP ±</th><th class="r" title="Chance to win the next game, from current ratings">Next game</th></tr></thead><tbody>${h2h.map(([oid, h]) => {
        const o = data.players[oid]; const pw = winProb(L.live[id], L.live[oid]);
        return `<tr><td><a class="pl" href="#p-${esc(oid)}">${avatar(o)}<span class="nm">${esc(o.name)}</span></a></td><td class="num">${h.w}-${h.l}${h.d ? '-' + h.d : ''}</td><td class="num r hide-lg">${h.cf}–${h.ca}</td><td class="num r ${dCls(h.net)}">${fmtD(h.net)}</td><td class="num r ${pw >= 0.5 ? 'up' : 'down'}">${fmtPct(pw)}</td></tr>`;
      }).join('')}</tbody></table>` : '<p class="muted" style="margin:0">No battles in this view.</p>'}</div>
    </section>
  </div>
  ${cardsSection(id, data, view)}
  <section class="panel">
    <div class="panel-h"><h2>Recent battles</h2><span class="muted" style="font-size:13px">${mine.length} in this view</span></div>
    <div class="panel-b">${mine.length ? `<div class="mlist">${mine.slice(-12).reverse().map(m => matchRow(m, data, view)).join('')}</div>` : '<p class="muted" style="margin:0">Nothing logged in this view yet.</p>'}</div>
  </section>`;
}

/* ---------- Stats tab ---------- */
const nameOf = (data, id) => esc(data.players[id]?.name || '?');
const pctOrDash = v => (v == null ? '—' : fmtPct(v));
const rec3 = o => `${o.w}-${o.l}${o.d ? '-' + o.d : ''}`;

// How the placed players spread across the ranks in this view.
function rankDistHtml(data, view) {
  const placed = Object.values(data.players).filter(p => !p.archived && view.st[p.id] && isPlaced(view.st[p.id]));
  if (!placed.length) return '';
  const by = new Map(RANKS.map(k => [k.name, []]));
  for (const p of placed) by.get(rank(view.st[p.id]).name).push(p);
  const total = placed.length;
  const segs = RANKS.slice().reverse().filter(k => by.get(k.name).length).map(k => { const n = by.get(k.name).length; return `<span class="rd-seg ${k.cls}" style="flex:${n}" title="${k.name}: ${by.get(k.name).map(p => p.name).join(', ')}"><b>${n}</b></span>`; }).join('');
  const rows = RANKS.slice().reverse().filter(k => by.get(k.name).length).map(k => `<div class="rd-row"><span class="chip ${k.cls}">${k.name}</span><span class="rd-names">${by.get(k.name).map(p => { const s = view.st[p.id], kk = rank(s); return `<a href="#p-${esc(p.id)}">${esc(p.name)}<small class="muted"> ${kk.div ? ['', 'I', 'II', 'III'][kk.div] : ''}</small></a>`; }).join('')}</span></div>`).join('');
  return `<section class="panel">
    <div class="panel-h"><h2>Ranks</h2><span class="muted" style="font-size:13px">${total} placed</span></div>
    <div class="panel-b"><div class="rank-dist" role="img" aria-label="Players per rank">${segs}</div><div class="rd-rows">${rows}</div></div>
  </section>`;
}
function raceChart(data, RC) {
  if (!RC.series.length) return '<p class="muted" style="margin:0">No rated battles in this view yet.</p>';
  const W = narrow() ? 430 : 760, H = narrow() ? 300 : 300, l = 40, r = narrow() ? 104 : 120, t = 14, b = 28;
  const rs = RC.series.flatMap(s => s.pts.map(p => p.r));
  const step = Math.max(...rs) - Math.min(...rs) > 400 ? 100 : 50;
  let lo = Math.floor((Math.min(...rs) - 20) / step) * step, hi = Math.ceil((Math.max(...rs) + 20) / step) * step;
  if (hi - lo < step * 3) { lo -= step; hi += step; }
  const span = Math.max(1, RC.end - RC.start);
  const x = tt => l + ((Math.min(RC.end, Math.max(RC.start, tt)) - RC.start) / span) * (W - l - r);
  const y = v => t + (1 - (v - lo) / (hi - lo)) * (H - t - b);
  let g = '';
  for (let v = lo; v <= hi; v += step) g += `<line class="grid" x1="${l}" x2="${W - r}" y1="${y(v)}" y2="${y(v)}"/><text x="${l - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  // Step lines: RP holds until the next game.
  const lines = RC.series.map(s => {
    const p = data.players[s.id];
    let d = `M${x(s.pts[0].t).toFixed(1)} ${y(s.pts[0].r).toFixed(1)}`;
    for (let i = 1; i < s.pts.length; i++) d += `H${x(s.pts[i].t).toFixed(1)}V${y(s.pts[i].r).toFixed(1)}`;
    return `<path class="rline" d="${d}" style="stroke:${esc(p.color)}"><title>${esc(p.name)}</title></path>`;
  }).join('');
  // End labels, nudged apart so names don't overlap.
  const labels = RC.series.map(s => ({ s, y: y(s.last) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 15) labels[i].y = labels[i - 1].y + 15;
  const lab = labels.map(({ s, y: yy }) => { const p = data.players[s.id]; return `<circle cx="${W - r}" cy="${y(s.last).toFixed(1)}" r="3.5" style="fill:${esc(p.color)}"/><text class="rlab" x="${W - r + 8}" y="${(yy + 4).toFixed(1)}" style="fill:${esc(p.color)}">${esc(trunc(p.name, narrow() ? 9 : 11))} ${R0(s.last)}</text>`; }).join('');
  const d0 = new Date(RC.start), d1 = new Date(RC.end);
  const fmt = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="RP race: ${RC.series.map(s => `${esc(data.players[s.id].name)} ${R0(s.last)}`).join(', ')}">
    ${g}<line class="base" x1="${l}" x2="${W - r}" y1="${y(1500)}" y2="${y(1500)}"/>${lines}${lab}
    <text x="${l}" y="${H - 6}">${fmt(d0)}</text><text x="${W - r}" y="${H - 6}" text-anchor="end">${fmt(d1)}</text>
  </svg>`;
}
const R0 = v => Math.round(v);
const trunc = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

function heatmapHtml(hm) {
  if (!hm.total) return '<p class="muted" style="margin:0">No battles in this view yet.</p>';
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const hourLbl = h => (h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? h + 'a' : (h - 12) + 'p');
  let busiest = { n: 0 };
  hm.grid.forEach((row, d) => row.forEach((n, h) => { if (n > busiest.n) busiest = { n, d, h }; }));
  return `<div class="heat" role="img" aria-label="Battles by day and hour. Busiest: ${days[busiest.d]} around ${hourLbl(busiest.h)}.">
    <span></span>${Array.from({ length: 24 }, (_, h) => `<span class="hh">${h % 6 === 0 ? hourLbl(h) : ''}</span>`).join('')}
    ${hm.grid.map((row, d) => `<span class="hd">${days[d]}</span>${row.map((n, h) => `<i style="--a:${n ? (0.18 + 0.82 * n / hm.max).toFixed(2) : 0}" title="${days[d]} ${hourLbl(h)}: ${n} battle${n === 1 ? '' : 's'}"></i>`).join('')}`).join('')}
  </div>
  <p class="muted chart-note">Busiest slot: <b>${days[busiest.d]} around ${hourLbl(busiest.h)}</b> (${busiest.n} battle${busiest.n === 1 ? '' : 's'}). Times are in ${esc(tz().replace('_', ' '))}.</p>`;
}

function recordCard(data, r) {
  const who = r.who.map(id => `<a href="#p-${esc(id)}">${avatar(data.players[id])}<b>${nameOf(data, id)}</b></a>`).join('');
  const sub = [r.vs ? `vs ${nameOf(data, r.vs)}` : '', r.season ? esc(seasonLabel(r.season)) : '', r.when ? esc(fmtDate(r.when, false)) : ''].filter(Boolean).join(' · ');
  return `<div class="record${r.shame ? ' shame' : ''}"><div class="rk">${esc(r.title)}</div><div class="rv">${esc(r.value)}</div><div class="rw">${who}</div><div class="rs muted">${sub}</div></div>`;
}

function viewStats(data, L, view) {
  if (!Object.keys(data.players).length) return viewEmpty();
  const key = S.season === 'all' ? 'all' : (S.season || L.currentKey);
  const RC = memo('race|' + key, () => race(data, L, key, tz()));
  const rec = memo('records', () => records(data, L, tz()));
  const cl = memo('clutch|' + key, () => clutch(data, view)), lk = memo('leaks|' + key, () => leaks(data, view));
  const tl = memo('tilt|' + key, () => tilt(data, view)).filter(r => r.afterW.n + r.afterL.n >= 2);
  const mt = memo('meta|' + key, () => meta(data, view)), hm = memo('heat|' + key, () => heatmap(view, tz()));
  const hpGames = view.ms.filter(m => hpInfo(m)).length;

  const clutchTbl = cl.length ? `<table class="compact"><thead><tr><th>Player</th><th>Close games</th><th class="r">Win %</th><th class="r" title="Average remaining tower HP minus the opponent's">HP edge</th></tr></thead><tbody>
    ${cl.map(r => `<tr><td><a class="pl" href="#p-${esc(r.id)}">${avatar(data.players[r.id])}<span class="nm">${nameOf(data, r.id)}</span></a></td><td class="num">${r.close.n ? rec3(r.close) : '—'}</td><td class="num r ${r.closeRate == null ? '' : r.closeRate >= 0.5 ? 'up' : 'down'}">${pctOrDash(r.closeRate)}</td><td class="num r ${r.avgMargin >= 0 ? 'up' : 'down'}">${r.avgMargin >= 0 ? '+' : '−'}${Math.abs(R0(r.avgMargin)).toLocaleString()}</td></tr>`).join('')}
    </tbody></table>` : '<p class="muted" style="margin:0">Needs auto-imported battles with tower HP.</p>';
  const leakTbl = lk.length ? `<table class="compact"><thead><tr><th>Player</th><th class="r">Leaked / game</th><th class="r">In wins</th><th class="r">In losses</th></tr></thead><tbody>
    ${lk.map(r => `<tr><td><a class="pl" href="#p-${esc(r.id)}">${avatar(data.players[r.id])}<span class="nm">${nameOf(data, r.id)}</span></a></td><td class="num r"><span class="leakbar"><i style="width:${Math.min(100, r.avg * 10)}%"></i></span>${r.avg.toFixed(1)}</td><td class="num r">${r.avgWin == null ? '—' : r.avgWin.toFixed(1)}</td><td class="num r">${r.avgLoss == null ? '—' : r.avgLoss.toFixed(1)}</td></tr>`).join('')}
    </tbody></table>` : '<p class="muted" style="margin:0">Needs auto-imported battles with elixir data.</p>';
  const tiltCell = (rate, o, cls = '') => `<td class="num r ${cls}">${pctOrDash(rate)}<span class="games"><span class="g-long">${o.n} game${o.n === 1 ? '' : 's'}</span><span class="g-short">(${o.n})</span></span></td>`;
  const tiltTbl = tl.length ? `<table class="compact tilt"><thead><tr><th>Player</th><th class="r">After a win</th><th class="r">After a loss</th><th class="r hide-md">1st game of a session</th><th class="r hide-md">Later games</th><th>Verdict</th></tr></thead><tbody>
    ${tl.map(r => {
      const gap = r.afterWRate != null && r.afterLRate != null ? r.afterWRate - r.afterLRate : null;
      const verdict = gap != null && Math.abs(gap) >= 0.2 && r.afterL.n >= 3 ? `<span class="chip ${gap > 0 ? 'tiltchip' : 'calmchip'}">${gap > 0 ? 'Tilts' : 'Resilient'}</span>` : '<span class="muted">—</span>';
      return `<tr><td><a class="pl" href="#p-${esc(r.id)}">${avatar(data.players[r.id])}<span class="nm">${nameOf(data, r.id)}</span></a></td>
        ${tiltCell(r.afterWRate, r.afterW)}${tiltCell(r.afterLRate, r.afterL)}${tiltCell(r.firstRate, r.first, 'hide-md')}${tiltCell(r.laterRate, r.later, 'hide-md')}<td>${verdict}</td></tr>`;
    }).join('')}
    </tbody></table><p class="muted chart-note">Win rate in each situation. A new session starts after a ${SESSION_GAP_MIN}+ minute break. "Tilts" means 20+ points worse after a loss than after a win (3+ games after a loss); "Resilient" is the reverse.</p>` : '<p class="muted" style="margin:0">Not enough games yet.</p>';
  const metaHtml = mt.decks ? `<div class="cardcols">
      <div class="table-wrap"><h3 class="sub">Archetypes</h3><table class="compact"><thead><tr><th>Deck type</th><th class="r">Played</th><th class="r">Win %</th><th class="hide-sm">Main pilots</th></tr></thead><tbody>
        ${mt.archetypes.slice(0, 10).map(a => `<tr><td class="wrap"><b>${esc(a.name)}</b></td><td class="num r">${a.n}</td><td class="num r ${a.rate >= 0.5 ? 'up' : 'down'}">${fmtPct(a.rate)}</td><td class="hide-sm muted" style="white-space:normal">${a.mains.slice(0, 3).map(x => `${nameOf(data, x.pid)} (${x.n})`).join(', ')}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="table-wrap"><h3 class="sub">Most played cards</h3><table class="ctable compact"><thead><tr><th>Card</th><th class="r">In decks</th><th class="r">Win %</th></tr></thead><tbody>
        ${mt.cards.slice(0, 12).map(c => `<tr><td><span class="cname">${cardTile(c.card, ' sm')}<span>${esc(c.card.name)}</span></span></td><td class="r"><span class="usebar"><i style="width:${Math.round(c.usage * 100)}%"></i></span><span class="num">${fmtPct(c.usage)}</span></td><td class="r num ${c.rate >= 0.5 ? 'up' : 'down'}">${fmtPct(c.rate)}</td></tr>`).join('')}
      </tbody></table></div>
    </div><p class="muted chart-note">From ${mt.decks} decks in auto-imported battles. Archetypes are named by their win conditions.</p>` : '<p class="muted" style="margin:0">Deck data fills in from auto-imported battles.</p>';

  return seasonBar(L) + `
  <section class="panel recap-panel">
    <div class="panel-h"><h2>Weekly recap</h2><span class="muted" style="font-size:13px">Last 7 days, ready for the group chat</span></div>
    <div class="panel-b recap">
      <canvas id="recapCanvas" width="1080" height="1350" aria-label="Weekly recap image"></canvas>
      <div class="recap-side">
        <p class="muted" style="margin:0">A shareable image of the last 7 days: battles, the biggest climber, most wins, the upset of the week and the top 5.</p>
        <div class="actions"><button class="btn primary" type="button" data-act="recap-dl">${TOUCH.matches && navigator.canShare ? 'Save or share image' : 'Download image'}</button><button class="btn" type="button" data-act="recap-copy" id="recapCopy">Copy image</button></div>
      </div>
    </div>
  </section>
  <section class="panel">
    <div class="panel-h"><h2>${key === 'all' ? 'RP race, all time' : 'Season race'}</h2><span class="muted" style="font-size:13px">RP after every rated battle, step by step</span></div>
    <div class="panel-b">${raceChart(data, RC)}</div>
  </section>
  ${rankDistHtml(data, view)}
  <section class="panel">
    <div class="panel-h"><h2>Record book</h2><span class="muted" style="font-size:13px">All time</span></div>
    <div class="panel-b records">${rec.length ? rec.map(r => recordCard(data, r)).join('') : '<p class="muted" style="margin:0">Records appear once a few battles are in.</p>'}</div>
  </section>
  <div class="grid2">
    <section class="panel"><div class="panel-h"><h2>Clutch</h2><span class="muted" style="font-size:13px">${hpGames} battles with tower HP</span></div><div class="panel-b table-wrap">${clutchTbl}<p class="muted chart-note">Close game: a draw, a tiebreaker, or a 1-crown game won by ${CLOSE_HP.toLocaleString()} HP or less.</p></div></section>
    <section class="panel"><div class="panel-h"><h2>Elixir leaked</h2><span class="muted" style="font-size:13px">Lower is better</span></div><div class="panel-b table-wrap">${leakTbl}</div></section>
  </div>
  <section class="panel"><div class="panel-h"><h2>League meta</h2></div><div class="panel-b">${metaHtml}</div></section>
  <section class="panel"><div class="panel-h"><h2>Tilt check</h2></div><div class="panel-b table-wrap">${tiltTbl}</div></section>
  <section class="panel"><div class="panel-h"><h2>When we play</h2></div><div class="panel-b">${heatmapHtml(hm)}</div></section>`;
}

/* ---------- weekly recap image ---------- */
async function drawRecap(data, L) {
  const cv = document.getElementById('recapCanvas'); if (!cv) return;
  try { await document.fonts?.ready; } catch { /* fonts optional */ }
  const W = 1080, H = 1350, x = cv.getContext('2d');
  const wk = weekly(data, L);
  const view = L.byKey[L.currentKey];
  const top = ranking(data, view).filter(p => isPlaced(view.st[p.id])).slice(0, 5);
  const DISP = '"Lilita One", "Arial Rounded MT Bold", sans-serif', BODY = 'Archivo, system-ui, sans-serif';
  // Arena split background
  x.fillStyle = '#0b1222'; x.fillRect(0, 0, W, H);
  let g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, 'rgba(74,144,255,.28)'); g.addColorStop(0.5, 'rgba(74,144,255,.05)'); g.addColorStop(0.5, 'rgba(255,83,103,.05)'); g.addColorStop(1, 'rgba(255,83,103,.26)');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.strokeStyle = 'rgba(255,198,58,.55)'; x.lineWidth = 3; x.beginPath(); x.moveTo(W * 0.62, 0); x.lineTo(W * 0.38, H); x.stroke();
  // Crown
  const crown = (cx, cy, s) => { x.fillStyle = '#ffc63a'; x.beginPath(); const p = [[2, 6], [7, 10], [12, 2], [17, 10], [22, 6], [20, 17], [4, 17]]; p.forEach(([a, b], i) => (i ? x.lineTo : x.moveTo).call(x, cx + a * s, cy + b * s)); x.closePath(); x.fill(); x.fillRect(cx + 4 * s, cy + 18 * s, 16 * s, 2.5 * s); };
  crown(70, 70, 3.2);
  x.fillStyle = '#8e9bc1'; x.font = `700 26px ${BODY}`; x.fillText('WEEKLY RECAP', 160, 104);
  x.fillStyle = '#edf1ff'; x.font = `64px ${DISP}`; x.fillText(String(data.league.name || 'Friendly Battle League').slice(0, 26), 70, 200);
  const fmt = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  x.fillStyle = '#8e9bc1'; x.font = `500 30px ${BODY}`; x.fillText(`${fmt(wk.from)} – ${fmt(wk.to)}`, 70, 250);
  // Tiles
  const tile = (tx, ty, w, label, value, sub, color = '#edf1ff') => {
    x.fillStyle = 'rgba(19,28,52,.88)'; x.strokeStyle = '#26355c'; x.lineWidth = 2;
    x.beginPath(); x.roundRect(tx, ty, w, 170, 22); x.fill(); x.stroke();
    x.fillStyle = '#8e9bc1'; x.font = `700 22px ${BODY}`; x.fillText(label.toUpperCase(), tx + 28, ty + 46);
    x.fillStyle = color; x.font = `58px ${DISP}`; x.fillText(value, tx + 28, ty + 112, w - 56);
    if (sub) { x.fillStyle = '#8e9bc1'; x.font = `500 24px ${BODY}`; x.fillText(sub, tx + 28, ty + 150, w - 56); }
  };
  const nm = id => data.players[id]?.name || '?';
  tile(70, 300, 455, 'Battles', String(wk.battles), `${wk.threes} three-crown${wk.threes === 1 ? '' : 's'}`);
  tile(555, 300, 455, 'Top climber', wk.topGainer && wk.topGainer.net > 0 ? nm(wk.topGainer.id) : '—', wk.topGainer && wk.topGainer.net > 0 ? `+${R0(wk.topGainer.net)} RP` : 'Nobody climbed', '#3fd68f');
  tile(70, 500, 455, 'Most wins', wk.mostWins && wk.mostWins.w ? nm(wk.mostWins.id) : '—', wk.mostWins && wk.mostWins.w ? `${rec3(wk.mostWins)} this week` : '');
  const up = wk.upset;
  tile(555, 500, 455, 'Upset of the week', up ? nm(up.m.winner === 'a' ? up.m.a : up.m.b) : '—', up ? `beat ${nm(up.m.winner === 'a' ? up.m.b : up.m.a)} at ${Math.round(up.p * 100)}%` : 'Favorites held', '#ffc63a');
  // Standings
  x.fillStyle = '#edf1ff'; x.font = `44px ${DISP}`; x.fillText(`${seasonLabel(L.currentKey)} top ${top.length || ''}`.trim(), 70, 760);
  top.forEach((p, i) => {
    const y0 = 800 + i * 92, s = view.st[p.id], wkRow = wk.rows.find(r => r.id === p.id);
    x.fillStyle = i === 0 ? 'rgba(255,198,58,.12)' : 'rgba(19,28,52,.7)'; x.beginPath(); x.roundRect(70, y0, 940, 78, 16); x.fill();
    x.fillStyle = i === 0 ? '#ffc63a' : '#8e9bc1'; x.font = `40px ${DISP}`; x.fillText(String(i + 1), 100, y0 + 53);
    x.fillStyle = p.color; x.beginPath(); x.arc(185, y0 + 39, 25, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#0b1222'; x.font = `26px ${DISP}`; x.textAlign = 'center'; x.fillText(initials(p.name), 185, y0 + 49); x.textAlign = 'left';
    x.fillStyle = '#edf1ff'; x.font = `700 34px ${BODY}`; x.fillText(p.name, 230, y0 + 51, 430);
    x.textAlign = 'right';
    if (wkRow && Math.round(wkRow.net)) { x.fillStyle = wkRow.net > 0 ? '#3fd68f' : '#f27b8b'; x.font = `700 28px ${BODY}`; x.fillText(`${wkRow.net > 0 ? '+' : '−'}${Math.abs(R0(wkRow.net))} this week`, 820, y0 + 50); }
    x.fillStyle = i === 0 ? '#ffc63a' : '#edf1ff'; x.font = `40px ${DISP}`; x.fillText(`${R0(s.score)}`, 990, y0 + 44);
    x.fillStyle = '#8e9bc1'; x.font = `700 17px ${BODY}`; x.fillText(rank(s).label.toUpperCase(), 990, y0 + 68);
    x.textAlign = 'left';
  });
  x.fillStyle = '#8e9bc1'; x.font = `500 24px ${BODY}`; x.fillText(location.host || 'friendly battle league', 70, H - 50);
  const copy = document.getElementById('recapCopy');
  if (copy && !(window.ClipboardItem && navigator.clipboard?.write)) copy.hidden = true;
  // Encode the PNG a moment later so it never competes with opening the page.
  recapReady = null; clearTimeout(drawRecap._t);
  drawRecap._t = setTimeout(() => recapBlob().then(b => { recapReady = b; }), 700);
}
// toBlob returns nothing and calls back later, so it can't be chained with ?? (that resolved null every time).
function recapBlob() {
  const cv = document.getElementById('recapCanvas');
  return new Promise(res => (cv ? cv.toBlob(res, 'image/png') : res(null)));
}
// Made ahead of time: iOS only opens the share sheet straight from a tap, not after waiting on the image.
let recapReady = null;
const TOUCH = window.matchMedia('(pointer:coarse)');

/* ---------- Lab tab ---------- */
function calibrationChart(cal) {
  const W = 340, H = 300, l = 44, r = 14, t = 12, b = 36;
  const x = v => l + ((v - 0.5) / 0.5) * (W - l - r), y = v => t + (1 - v) * (H - t - b);
  const pts = cal.filter(c => c.n);
  const maxN = Math.max(1, ...pts.map(c => c.n));
  let g = '';
  for (const v of [0.5, 0.6, 0.7, 0.8, 0.9, 1]) g += `<line class="grid" x1="${x(v)}" x2="${x(v)}" y1="${t}" y2="${H - b}"/><text x="${x(v)}" y="${H - b + 16}" text-anchor="middle">${Math.round(v * 100)}%</text>`;
  for (const v of [0, 0.25, 0.5, 0.75, 1]) g += `<line class="grid" x1="${l}" x2="${W - r}" y1="${y(v)}" y2="${y(v)}"/><text x="${l - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v * 100)}%</text>`;
  const path = pts.map((c, i) => (i ? 'L' : 'M') + x(c.predicted).toFixed(1) + ' ' + y(c.actual).toFixed(1)).join('');
  return `<svg class="chart cal" viewBox="0 0 ${W} ${H}" role="img" aria-label="Calibration: ${pts.map(c => `predicted ${fmtPct(c.predicted)}, actual ${fmtPct(c.actual)} over ${c.n} games`).join('; ')}">
    ${g}<line class="diag" x1="${x(0.5)}" y1="${y(0.5)}" x2="${x(1)}" y2="${y(1)}"/>
    <path class="line" d="${path}"/>
    ${pts.map(c => `<circle class="calpt" cx="${x(c.predicted).toFixed(1)}" cy="${y(c.actual).toFixed(1)}" r="${(4 + 8 * Math.sqrt(c.n / maxN)).toFixed(1)}"><title>${fmtPct(c.lo)}–${fmtPct(c.hi)} favorites: predicted ${fmtPct(c.predicted)}, won ${fmtPct(c.actual)} (${c.n} games)</title></circle>`).join('')}
    <text x="${(l + W - r) / 2}" y="${H - 4}" text-anchor="middle">Favorite's predicted chance</text>
  </svg>`;
}
const paramRow = p => `τ ${p.tau} · carry ${Math.round(p.carry * 100)}% · RD floor ${p.rdFloor} · margin ×${p.marginScale}`;
function viewLab(data, L) {
  const opts = { tz: tz(), now: Date.now() };
  const g = backtest(data, undefined, opts), e = eloPreds(data, opts);
  const sg = scorePreds(g), se = scorePreds(e);
  if (sg.n < 5) return `<section class="panel"><div class="panel-h"><h2>Lab</h2></div><div class="panel-b"><p class="muted" style="margin:0">The Lab needs at least 5 rated battles to say anything useful. Play some friendlies first.</p></div></section>`;
  const cal = calibration(g);
  const lnc = Math.log(2);
  const better = (a, b2) => (a < b2 ? 'up' : 'down');
  const T = S.tune && S.tune.sig === labSig(data) ? S.tune.res : null;
  const tuneHtml = !T ? `<p class="muted" style="margin:0 0 12px">Tries ${GRID.tau.length * GRID.carry.length * GRID.rdFloor.length * GRID.marginScale.length} combinations of the rating settings, fitting on the oldest 70% of battles and scoring on the newest 30% (which the search never sees). If the "best" settings don't also win on that held-out 30%, the gain was just noise.</p>
      <button class="btn primary" type="button" data-act="run-tune">Run tuning</button>`
    : T.tooFew ? `<p class="muted" style="margin:0">Needs at least 20 rated battles (you have ${T.n}).</p>`
    : (() => {
      const dTest = T.current.test - T.best.test;
      const verdict = dTest > 0.01 ? `<b class="up">Worth switching.</b> The tuned settings also predict the held-out battles better (log-loss ${T.best.test.toFixed(3)} vs ${T.current.test.toFixed(3)}).`
        : dTest > 0 ? `<b>Marginal.</b> The tuned settings are only slightly better on held-out battles (${T.best.test.toFixed(3)} vs ${T.current.test.toFixed(3)}). Probably noise at ${T.n} battles; keep the defaults for now.`
        : `<b>Keep the defaults.</b> The tuned settings fit the training battles better but don't beat the defaults on held-out battles (${T.best.test.toFixed(3)} vs ${T.current.test.toFixed(3)}), so the gain was overfitting.`;
      return `<p style="margin:0 0 12px">${verdict}</p>
        <table><thead><tr><th>Settings</th><th class="r">Train (${T.cut})</th><th class="r">Held out (${T.n - T.cut})</th></tr></thead><tbody>
          <tr><td><b>Current</b> <span class="muted">${paramRow(T.current.params)}</span></td><td class="num r">${T.current.train.toFixed(3)}</td><td class="num r">${T.current.test.toFixed(3)}</td></tr>
          ${T.top.map((x2, i) => `<tr><td>${i === 0 ? '<b>Best fit</b> ' : ''}<span class="muted">${paramRow(x2.params)}</span></td><td class="num r">${x2.train.toFixed(3)}</td><td class="num r ${better(x2.test, T.current.test)}">${x2.test.toFixed(3)}</td></tr>`).join('')}
        </tbody></table>
        <p class="muted chart-note">Log-loss, lower is better. Tried ${T.tried} combinations. To apply a setting, change it in <code>public/rating.js</code> (or ask me).</p>
        <div style="margin-top:10px"><button class="btn small" type="button" data-act="run-tune">Run again</button></div>`;
    })();
  return `<section class="panel lab-intro"><div class="panel-b">
      <div class="eyebrow">Lab</div>
      <h2 class="lab-h">Is the rating system actually any good?</h2>
      <p class="muted" style="margin:0;max-width:72ch">Every win chance shown in the app is a prediction made before the battle. These checks replay all ${sg.n} rated battles and score those predictions against what happened, so you can see whether the model earns its numbers.</p>
    </div></section>
  <section class="strip" aria-label="Prediction scores">
    <div><div class="k">Log-loss</div><div class="v num">${sg.logLoss.toFixed(3)}</div><div class="s">Coin flip: ${lnc.toFixed(3)} · Elo: <span class="${better(se.logLoss, sg.logLoss)}">${se.logLoss.toFixed(3)}</span></div></div>
    <div><div class="k">Brier score</div><div class="v num">${sg.brier.toFixed(3)}</div><div class="s">Coin flip: 0.250 · Elo: <span class="${better(se.brier, sg.brier)}">${se.brier.toFixed(3)}</span></div></div>
    <div><div class="k">Favorite won</div><div class="v num">${sg.accuracy == null ? '—' : fmtPct(sg.accuracy)}</div><div class="s">of ${sg.decided} decided battles · Elo ${se.accuracy == null ? '—' : fmtPct(se.accuracy)}</div></div>
    <div><div class="k">Rated battles</div><div class="v num">${sg.n}</div><div class="s">${sg.n < 100 ? 'Small sample: read loosely' : 'Decent sample'}</div></div>
  </section>
  <div class="grid2">
    <section class="panel">
      <div class="panel-h"><h2>Calibration</h2></div>
      <div class="panel-b">${calibrationChart(cal)}<p class="muted chart-note">Each dot is a group of battles by the favorite's predicted chance (dot size = number of battles). On the dashed line, a "70%" favorite really wins 70% of the time. Below it, the model is overconfident; above it, underconfident.</p></div>
    </section>
    <section class="panel">
      <div class="panel-h"><h2>By bucket</h2></div>
      <div class="panel-b table-wrap"><table class="compact"><thead><tr><th>Favorite's chance</th><th class="r">Battles</th><th class="r">Predicted</th><th class="r">Won</th></tr></thead><tbody>
        ${cal.map(c => `<tr><td>${fmtPct(c.lo)}–${fmtPct(c.hi)}</td><td class="num r">${c.n}</td><td class="num r">${c.n ? fmtPct(c.predicted) : '—'}</td><td class="num r ${c.n ? (Math.abs(c.actual - c.predicted) <= 0.08 ? 'up' : 'down') : ''}">${c.n ? fmtPct(c.actual) : '—'}</td></tr>`).join('')}
      </tbody></table>
      <p class="muted chart-note">Log-loss punishes confident wrong calls hardest; 0.693 is what always guessing 50% scores. Brier is the mean squared error of the probabilities; 0.25 for always guessing 50%. The Elo column is plain Elo (K=24, no margins, no seasons) on the same battles, as a baseline.</p></div>
    </section>
  </div>
  <section class="panel">
    <div class="panel-h"><h2>Tune the settings</h2><span class="muted" style="font-size:13px">Grid search with a held-out test set</span></div>
    <div class="panel-b table-wrap">${tuneHtml}</div>
  </section>`;
}
const labSig = data => `${Object.keys(data.matches).length}|${Object.keys(data.players).length}|${S.demo ? 'demo' : 'live'}`;

/* ---------- about + first-visit how-to ---------- */
const syncMin = () => S.sync?.intervalMinutes ?? 10;
function viewAbout(data) {
  const name = esc(data.league.name || 'Friendly Battle League');
  const faq = [
    ['My friendly didn\'t show up. Why?', `Both players need their player tag saved in the league, and it has to be a 1v1 friendly or clan-mate battle. The server checks battle logs every ${syncMin()} minutes, so give it a few. The game only keeps your last 25 battles, so if <i>both</i> of you played 25+ other games before the next check, it's gone. An editor can always log it by hand.`],
    ['Do ladder, 2v2, or tournament games count?', 'No. Only 1v1 friendly battles between two league members count. Your ladder trophies have nothing to do with your RP here.'],
    ['What\'s the difference between RP and my skill range?', 'Your <b>skill range</b> is where the system thinks your true skill sits; it narrows as you play. <b>RP</b> is the bottom of that range: the skill the system is about 95% sure you have. Standings and ranks use RP, so a hot start on few games can\'t top the table until it holds up. The skill range only shows on your profile.'],
    ['Why am I unplaced?', `The system isn't sure enough about you yet, so your RP and rank are hidden. It takes about ${PLACEMENT_HINT} battles the first time, and about 3 at the start of each season. Unplaced players sit below the standings until they're done.`],
    ['Why is someone with a worse record ranked above me?', 'Ranks go by RP, not by wins. Beating stronger players is worth more than beating weaker ones, winning by more crowns is worth more, and the system has to be sure about you. Two players with the same record can sit in different divisions.'],
    ['My RP dropped and I didn\'t even play.', 'That\'s your skill range widening while you\'re inactive. The longer you\'re away, the less sure the system is about you, so RP (the bottom of the range) slowly drifts down. Playing again brings it back.'],
    ['What happens when crowns are tied?', 'The app reads both sides\' remaining tower HP from the battle log and applies the in-game tiebreaker rule. If that info isn\'t there, it counts as a draw.'],
    ['A match is wrong. Can it be fixed?', 'Yes. Anyone with the league password can edit or delete any match. RP is recalculated from the full history every time, so fixing an old match fixes everything after it. Deleted imports stay deleted and won\'t sneak back in on the next sync.'],
    ['How do I edit stuff?', 'Tap <b>Unlock editing</b> at the bottom of the page and enter the league password. Anyone can view the league without it.'],
    ['Can I put this on my home screen?', 'Yes. On iPhone, open it in Safari, tap Share, then <b>Add to Home Screen</b>. On Android or desktop Chrome, use <b>Install app</b> from the browser menu. It opens full-screen like a regular app.'],
    ['Is the rating system actually any good?', 'Check the <a href="#lab">Lab</a>. It replays every rated battle and scores the win predictions against what actually happened, and compares them to plain Elo.'],
  ];
  const D = DIVISION_RP;
  const rankRows = RANKS.slice().reverse().map((k, i) => {
    const top = i === 0, wood = i === RANKS.length - 1;
    const divs = top ? `${k.min}+ RP` : `III ${wood ? `under ${k.min + D}` : `${k.min}–${k.min + D - 1}`} · II ${k.min + D}–${k.min + 2 * D - 1} · I ${k.min + 2 * D}–${k.min + 3 * D - 1}`;
    return `<li><span class="chip ${k.cls}">${k.name}</span><span class="muted num">${divs}</span></li>`;
  }).join('');
  return `<section class="panel about-hero"><div class="panel-b">
      <div class="eyebrow">About</div>
      <h2 class="lab-h">What is ${name}?</h2>
      <p class="muted">A ranked league for Clash Royale friendly battles. Friendlies don't count for anything in the game, so this tracks them: every 1v1 friendly between league members gets pulled in automatically, rated, and added to a monthly season with a champion at the end.</p>
    </div></section>
  <div class="grid2 about-grid">
    <section class="panel"><div class="panel-h"><h2>How battles get in</h2></div><div class="panel-b"><ul class="about-list">
      <li>Every player in the league has their <b>player tag</b> saved. Every ${syncMin()} minutes the server reads each player's battle log from the official Clash Royale API.</li>
      <li>Any 1v1 friendly between two league members is added, with crowns, decks, tower HP and the exact time.</li>
      <li>The same battle shows up in both players' logs but only gets counted once.</li>
      <li>Editors can also log matches by hand. If a hand-logged match lines up with an imported one, they're merged instead of doubled.</li>
    </ul></div></section>
    <section class="panel"><div class="panel-h"><h2>Seasons</h2></div><div class="panel-b"><ul class="about-list">
      <li>Seasons run by calendar month.</li>
      <li>On the 1st, skill moves halfway back to ${START_R} and everyone's skill range widens, so everyone replays a few placement battles before their RP shows again.</li>
      <li>The most RP at the end of the month, placed and with at least ${MIN_CHAMP_GAMES} battles, is crowned <b>season champion</b>.</li>
      <li>Use the season picker at the top of most pages to look back at older months or all time.</li>
    </ul></div></section>
  </div>
  <section class="panel"><div class="panel-h"><h2>RP, ranks and skill</h2></div><div class="panel-b"><ul class="about-list">
    <li>Under the hood the league runs <b>Glicko-2</b>, an upgraded Elo. Every player has a hidden skill estimate and a <b>skill range</b> around it: how sure the system is. The range narrows as you play and widens while you're away.</li>
    <li><b>Ranked Points (RP)</b> are the bottom of your skill range (skill − 2×RD): the skill the system is about 95% sure you have. Standings, ranks and champions all use RP. A lucky first game can't top the table, but a real hot streak against strong players still climbs fast.</li>
    <li>Beating someone with higher skill earns more. Results move uncertain players (new, or coming back) further than settled ones. Draws split the points; tiebreaker wins count as wins.</li>
    <li><b>Crowns matter.</b> Against an even opponent, a 2-crown win moves skill 1.15× as much as a 1-crown win, and a 3-crown win 1.3×. The bonus grows when the underdog wins and shrinks when a big favorite stomps a weaker player. The loser drops by the same multiple.</li>
    <li><b>Placements.</b> Until the system is sure enough about you (RD ${PROVISIONAL_RD} or less) you're <b>unplaced</b>: no RP, no rank, listed below the standings. That's about ${PLACEMENT_HINT} battles the first time and about 3 at the start of each season.</li>
    <li>Win chances come from both players' skill ranges, so two wide ranges pull the odds toward 50/50. An <b>Upset</b> is a win the system gave under 35%.</li>
    <li>Nothing is stored as a rating. Everything is recalculated from the full match history, so fixing an old match fixes everything after it.</li>
  </ul></div></section>
  <section class="panel"><div class="panel-h"><h2>Ranks</h2><span class="muted" style="font-size:13px">By RP. Each rank below Champion spans ${3 * DIVISION_RP} RP in three divisions, III up to I</span></div><div class="panel-b"><ul class="rank-list">${rankRows}</ul></div></section>
  <section class="panel"><div class="panel-h"><h2>What's on each page</h2></div><div class="panel-b"><dl class="about-pages">
    <div><dt><a href="#standings">Standings</a></dt><dd>The table: RP, rank, record, streak and recent form. Tap a player for their profile, skill history, decks and head-to-heads.</dd></div>
    <div><dt><a href="#matches">Matches</a></dt><dd>Every battle, newest first. Tap one for decks, tower HP and how much RP each player won or lost.</dd></div>
    <div><dt><a href="#rivalries">Rivalries</a></dt><dd>Pick any two players for their head-to-head record, win chance and how their decks match up.</dd></div>
    <div><dt><a href="#stats">Stats</a></dt><dd>The RP race, record book, clutch and tilt stats, the league meta, when people play, and a shareable weekly recap.</dd></div>
    <div><dt><a href="#lab">Lab</a></dt><dd>Nerd corner: how well the rating system predicts results, and a tuner that tests other settings.</dd></div>
  </dl></div></section>
  <section class="panel"><div class="panel-h"><h2>FAQ</h2></div><div class="panel-b faq">
    ${faq.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join('')}
  </div></section>`;
}

const HOWTO_KEY = 'crl-howto';
const seenHowTo = () => { try { return localStorage.getItem(HOWTO_KEY) === '1'; } catch { return true; } };   // storage blocked: don't nag every load
let howToTimer = 0;
// First time someone gets into the league (after the welcome screen, or from a shared link), a short how-it-works sheet.
function maybeHowTo(r) {
  if (howToTimer || seenHowTo() || r.v === 'about' || !(S.loaded || S.demo)) return;
  howToTimer = setTimeout(() => {
    howToTimer = 0;
    if (dlg.open || seenHowTo() || route().v === 'about' || route().v === 'welcome') return;
    try { localStorage.setItem(HOWTO_KEY, '1'); } catch { /* storage blocked */ }
    openDlg('How this works', `<ul class="howto">
        <li><span class="hi" aria-hidden="true">1</span><span><b>Play friendlies.</b> Any 1v1 friendly between league members gets picked up from the battle log within ~${syncMin()} minutes. No need to log anything.</span></li>
        <li><span class="hi" aria-hidden="true">2</span><span><b>Ranked Points, not just wins.</b> Beating stronger players and winning by more crowns earns more RP. RP also factors in how sure the system is about you, so your first ${PLACEMENT_HINT} or so battles are placements before it shows.</span></li>
        <li><span class="hi" aria-hidden="true">3</span><span><b>Ranks and seasons.</b> RP puts you in a rank, Wood up to Champion, with three divisions each. On the 1st everything partly resets, and the most RP with ${MIN_CHAMP_GAMES}+ battles at month's end is champion.</span></li>
        <li><span class="hi" aria-hidden="true">4</span><span>Tap any player, match or rivalry to dig in.</span></li>
      </ul>`,
      `<a class="btn" href="#about" data-act="close-nav">Full guide &amp; FAQ</a><button class="btn primary" type="button" data-act="close">Got it</button>`);
  }, 450);
}

/* ---------- routing + render ---------- */
const SEEN_KEY = 'crl-entered';
const seenIntro = () => { try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; } };
// The welcome page comes back once per season, so the new month opens on last month's champion.
const SEASON_SEEN_KEY = 'crl-season';
const getSeenSeason = () => { try { return localStorage.getItem(SEASON_SEEN_KEY) || ''; } catch { return ''; } };
const setSeenSeason = k => { try { localStorage.setItem(SEASON_SEEN_KEY, k); } catch { /* storage blocked */ } };
const nowSeason = () => seasonKey(Date.now(), tz());
const markSeen = () => { try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* storage blocked */ } setSeenSeason(nowSeason()); };

function route() {
  let h = location.hash.slice(1);
  try { h = decodeURIComponent(h); } catch { /* keep raw */ }
  // First visit in this browser (no hash) lands on the intro; after that, straight to standings.
  if (h === 'welcome') return { v: 'welcome', reason: 'manual' };
  if (h === '') {
    if (!seenIntro()) return { v: 'welcome', reason: 'first' };
    const seen = getSeenSeason();
    if (seen && seen !== nowSeason()) return { v: 'welcome', reason: 'season' };
  }
  if (h.startsWith('p-')) return { v: 'player', id: h.slice(2) };
  if (['matches', 'rivalries', 'stats', 'lab', 'about'].includes(h)) return { v: h };
  if (h.startsWith('r-')) return { v: 'rivalries', pair: h.slice(2) };
  return { v: 'standings' };
}
function renderSync() {
  // Two pills: one in the top tabs (desktop) and one in the header (phones, where the tabs move to the bottom).
  document.querySelectorAll('.syncpill').forEach(pill => {
    const txt = pill.querySelector('.synctext');
    const s = S.sync;
    if (S.demo || !s) { pill.hidden = true; return; }
    pill.hidden = false;
    pill.classList.remove('ok', 'err', 'busy');
    if (!s.enabled) { txt.innerHTML = '<span class="hide-sm">Auto-sync </span>off'; pill.title = s.lastError || ''; return; }
    if (s.running) { pill.classList.add('busy'); txt.textContent = 'Syncing…'; pill.title = ''; return; }
    if (s.lastError) { pill.classList.add('err'); txt.innerHTML = `Sync issue<span class="hide-sm"> · ${esc(ago(s.lastRunAt))}</span>`; pill.title = s.lastError; return; }
    pill.classList.add('ok');
    txt.innerHTML = s.lastRunAt ? `<span class="hide-sm">Synced </span>${esc(ago(s.lastRunAt))}` : '<span class="hide-sm">Auto-sync </span>on';
    pill.title = `Checks battle logs every ${s.intervalMinutes} min.${writable() ? ' Click to sync now.' : ''}`;
  });
}
function renderBanner() {
  const b = $('#banner');
  if (S.demo) {
    b.innerHTML = `<div class="banner demo"><span class="grow"><b>Sample data.</b> These players and matches are made up and nothing you change here is saved.</span><button class="btn small" type="button" data-act="demo-off">Back to my league</button></div>`;
  } else if (S.error) {
    b.innerHTML = `<div class="banner warn"><span class="grow">${esc(S.error)}</span></div>`;
  } else if (S.sync && S.sync.lastError && S.sync.enabled) {
    b.innerHTML = `<div class="banner warn"><span class="grow"><b>Auto-sync problem:</b> ${esc(S.sync.lastError)}</span></div>`;
  } else if (S.loaded && !S.editable) {
    b.innerHTML = `<div class="banner"><span class="grow">Editing is turned off on this server. Set LEAGUE_PASSWORD to enable it.</span></div>`;
  } else b.innerHTML = '';
}
/* ---------- intro ---------- */
let introKey = null, introPlayed = false;
function introHtml(data, L, reason) {
  // Podium shows the current season; on the 1st of a month (nobody's played yet) it shows last month's final table.
  let view = L.byKey[L.currentKey], caption = `${seasonLabel(L.currentKey)} standings`;
  const prevKey = L.seasons[1];
  // New season (or nobody has played yet this month): show last month's final table.
  if (prevKey && (reason === 'season' || !view.ms.length)) { view = L.byKey[prevKey]; caption = `${seasonLabel(prevKey)} final`; }
  const champ = reason === 'season' && prevKey ? L.champions.find(c => c.key === prevKey) : null;
  const champP = champ && data.players[champ.id];
  const ranked = ranking(data, view).filter(p => isPlaced(view.st[p.id]));
  const top3 = ranked.slice(0, 3);
  const players = Object.values(data.players).filter(p => !p.archived).length;
  // Streaks are about right now, so they come from the current season even when the podium shows last month.
  const cur = L.byKey[L.currentKey];
  let hot = null; for (const p of ranking(data, cur)) { const s = cur.st[p.id]; if (s.games && s.streakT === 'W' && (!hot || s.streakN > cur.st[hot.id].streakN)) hot = p; }
  const lastChamp = L.champions[0] && data.players[L.champions[0].id];
  const name = data.league.name || 'Friendly Battle League';
  const words = name.trim().split(/\s+/);
  const title = words.length > 1 ? `${esc(words.slice(0, -1).join(' '))} <span class="gold">${esc(words[words.length - 1])}</span>` : `<span class="gold">${esc(name)}</span>`;

  const pod = (p, place) => {
    if (!p) return `<div class="pod p${place} empty"><span class="av" aria-hidden="true">?</span><span class="nm muted">Open spot</span><span class="rt">—</span><div class="block">${place}</div></div>`;
    const s = view.st[p.id];
    return `<a class="pod p${place}" href="#p-${esc(p.id)}" data-act="enter-to" data-href="#p-${esc(p.id)}">
      ${place === 1 ? CROWN.replace('class="crown"', 'class="crown-top"') : ''}
      ${avatar(p)}<span class="nm">${esc(p.name)}</span><span class="rt num">${R(s.score)}</span>${rankChip(s, ' pod-rk')}
      <div class="block">${place}</div></a>`;
  };
  const podium = top3.length
    ? `<div class="podium-wrap"><div class="pod-cap">${esc(caption)}</div><div class="podium" aria-label="Top three">${pod(top3[1], 2)}${pod(top3[0], 1)}${pod(top3[2], 3)}</div></div>`
    : `<div class="podium"><div class="throne"><b>The throne is empty</b>${players ? 'Finish your placement battles to claim a spot.' : 'Add your crew and play a friendly to crown a champion.'}</div></div>`;

  const recent = L.all.ms.slice(-8).reverse().map(m => {
    const A = data.players[m.a], B = data.players[m.b];
    const [w, l, wc, lc] = m.winner === 'b' ? [B, A, m.cb, m.ca] : [A, B, m.ca, m.cb];
    const how = m.winner === 'draw' ? `<b>${esc(A.name)}</b> and <b>${esc(B.name)}</b> drew ${m.ca}–${m.cb}`
      : `<b>${esc(w.name)}</b> beat <b>${esc(l.name)}</b> ${wc}–${lc}${m.ca === m.cb ? ' on the tiebreaker' : wc === 3 ? ', three crowns' : ''}`;
    return `<span>${how}<span class="ago">${ago(m.playedAt)}</span></span>`;
  });
  const ticker = recent.length ? `<div class="ticker" aria-label="Recent results"><div class="ticker-track">${recent.join('')}${recent.length > 2 ? `<span aria-hidden="true" style="display:contents">${recent.join('')}</span>` : ''}</div></div>` : '<div></div>';

  return `<div class="intro-inner">
      <div class="intro-copy">
        <div class="eyebrow">${reason === 'season' ? `<span class="newseason">New season</span> · ${esc(seasonLabel(L.currentKey))}` : `Clash Royale friendly battles · ${esc(seasonLabel(L.currentKey))} season`}</div>
        <h1 class="intro-title">${title}</h1>
        ${reason === 'season' && prevKey ? `<p class="intro-sub">${champP
          ? `${MEDAL}<b>${esc(champP.name)}</b> is the ${esc(seasonLabel(prevKey))} champion, finishing on <b>${R(champ.score ?? champ.r)} RP</b>. A new season starts now: skill moved halfway back to 1500 and everyone replays placements before their RP shows.`
          : `${esc(seasonLabel(prevKey))} is over. Nobody played the ${MIN_CHAMP_GAMES} battles needed to be crowned, so the title is up for grabs. Skill moved halfway back to 1500 for the new season, and everyone replays placements.`}</p>`
        : `<p class="intro-sub">${L.all.ms.length ? `<b>${players}</b> players, <b>${L.all.ms.length}</b> battles and one crown per month.${lastChamp ? ` Last season's champ: <b>${esc(lastChamp.name)}</b>.` : ' Every friendly counts, and the battle log keeps score.'}` : 'Every friendly counts. Battles between league members are tracked automatically and settled in Ranked Points.'}</p>`}
        <div class="intro-actions"><button class="btn primary big" type="button" data-act="enter">Enter the league <span class="arr" aria-hidden="true">→</span></button><a class="intro-about" href="#about" data-act="enter-to" data-href="#about">How it works</a></div>
        <div class="intro-facts">
          <div><span class="v">${esc(daysLeft(L).replace(' left', ''))}</span><span class="k">Left this season</span></div>
          <div><span class="v">${hot ? esc(hot.name) : '—'}</span><span class="k">${hot ? `On a W${cur.st[hot.id].streakN} streak` : 'Hottest streak'}</span></div>
          <div><span class="v num">${players}</span><span class="k">Players</span></div>
        </div>
      </div>
      ${podium}
    </div>
    ${ticker}`;
}
function renderIntro(L) {
  const el = $('#intro');
  if (!L) { // still loading (arena background only) or the server couldn't be reached
    el.innerHTML = S.error ? `<div class="intro-inner"><div class="intro-copy"><h1 class="intro-title">${esc(D().league.name || 'Friendly Battle League')}</h1><p class="intro-sub">${esc(S.error)}</p></div></div>` : '';
    introKey = null; return;
  }
  const html = introHtml(D(), L, route().reason);
  if (html === introKey) return; // background refreshes shouldn't replay the entrance
  introKey = html;
  el.innerHTML = html;
  el.classList.toggle('play', !introPlayed);
  introPlayed = true;
}
function enterLeague(hash = '#standings') {
  markSeen();
  location.hash = hash;
}

const tz = () => (S.demo ? 'America/Chicago' : S.tz);
// Ratings only change when the data does, so switching tabs reuses the last result (refreshed each minute for idle-time drift).
let leagueMemo = null;
function league(data) {
  const now = Date.now(), k = `${tz()}|${Math.floor(now / 60000)}`;
  if (!leagueMemo || leagueMemo.data !== data || leagueMemo.k !== k) leagueMemo = { data, k, L: computeLeague(data, { tz: tz(), now }), memo: new Map() };
  return leagueMemo.L;
}
// Cache a derived stat for as long as the current league result lives.
function memo(key, fn) {
  const m = leagueMemo?.memo; if (!m) return fn();
  if (!m.has(key)) m.set(key, fn());
  return m.get(key);
}
function pickView(L) {
  if (S.season === 'all') return L.all;
  return L.byKey[S.season] || L.byKey[L.currentKey];
}

function render() {
  const data = D();
  if (seenIntro() && !getSeenSeason()) setSeenSeason(nowSeason());
  const r0 = route();
  const onIntro = r0.v === 'welcome';
  $('#intro').hidden = !onIntro;
  $('#app').hidden = onIntro;
  const ready = S.loaded || S.demo;
  const L = ready ? league(data) : null;
  if (L && S.season && S.season !== 'all' && !L.byKey[S.season]) S.season = '';
  if (onIntro) { document.title = data.league.name || 'Friendly Battle League'; renderIntro(L); return; }
  introPlayed = introKey !== null; introKey = null;
  $('#leagueName').textContent = data.league.name || 'Friendly Battle League';
  document.title = data.league.name || 'Friendly Battle League';
  const w = writable();
  document.querySelectorAll('.edit-only').forEach(el => { el.hidden = !w; });
  $('#lockBtn').hidden = !(S.unlocked && !S.demo);
  $('#unlockBtn').hidden = w || !S.editable || !!S.demo;
  $('#leagueBtn').disabled = !w;
  renderBanner();
  renderSync();
  const r = route();
  document.querySelectorAll('nav.tabs a, nav.bottombar a').forEach(a => {
    if (a.dataset.tab === r.v || (r.v === 'player' && a.dataset.tab === 'standings')) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  syncInd();
  if (!ready) {
    $('#view').innerHTML = S.error ? `<div class="loading">${esc(S.error)}</div>` : '<div class="loading">Loading the league…</div>';
    return;
  }
  const view = pickView(L);
  // Keep focus on the season picker across re-renders so keyboard users don't lose their place.
  const focusId = document.activeElement?.id;
  const views = { matches: viewMatches, rivalries: viewRivalries, stats: viewStats, lab: viewLab, about: viewAbout };
  $('#view').innerHTML = r.v === 'player' ? viewPlayer(r.id, data, L, view) : (views[r.v] || viewStandings)(data, L, view);
  if (r.v === 'stats') drawRecap(data, L);
  if (focusId && ['seasonSel', 'filterSel', 'predA', 'predB'].includes(focusId)) document.getElementById(focusId)?.focus();
  maybeHowTo(r);
}
PHONE_MQ.addEventListener('change', () => { if (!dlg.open) render(); });
/* ---------- page transitions ---------- */
// Pages slide in the direction the tabs sit: the phone bar puts Standings in the middle, the desktop tabs start with it.
const tabOrder = () => [...document.querySelectorAll(narrow() ? 'nav.bottombar a' : 'nav.tabs a')].map(a => a.dataset.tab);
const tabOf = r => (r.v === 'player' ? 'standings' : r.v);
let navPrev = route();
function animateView(dir) {
  const v = $('#view'); if (!dir || !v.animate) return;
  v.classList.remove('nav-fwd', 'nav-back', 'nav-fade'); void v.offsetWidth;   // restart if one is mid-flight
  v.classList.add('nav-' + dir);
  v.addEventListener('animationend', () => v.classList.remove('nav-' + dir), { once: true });
}
window.addEventListener('hashchange', () => {
  S.matchLimit = 50;
  const from = navPrev, to = route(); navPrev = to;
  render(); window.scrollTo(0, 0);
  if (from.v === 'welcome' || to.v === 'welcome') return;
  const order = tabOrder(), a = order.indexOf(tabOf(from)), b = order.indexOf(tabOf(to));
  animateView(a < 0 || b < 0 ? 'fade' : b > a ? 'fwd' : b < a ? 'back' : 'fade');   // About isn't a tab: fade
});

/* ---------- phone tab bar: a glass indicator that slides to the tab you tap, or follows your finger ---------- */
const bar = $('nav.bottombar'), ind = bar.querySelector('.bb-ind'), barTabs = [...bar.querySelectorAll('a')];
let barDrag = null, barClickAt = -1e9;
function placeInd(el, animate = true) {
  if (!el || !el.offsetWidth) return;                       // bar hidden (desktop)
  const first = !bar.classList.contains('has-ind');
  if (first || !animate) bar.classList.add('no-anim');
  ind.style.setProperty('--x', el.offsetLeft + 'px'); ind.style.setProperty('--w', el.offsetWidth + 'px');
  bar.classList.add('has-ind');
  if (first || !animate) { void ind.offsetWidth; bar.classList.remove('no-anim'); }
}
function syncInd(animate = true) {
  if (barDrag) return;
  const cur = bar.querySelector('a[aria-current="page"]');
  if (!cur) { bar.classList.remove('has-ind'); return; }   // a page that isn't a tab (About): no lens
  placeInd(cur, animate);
}
const tabAt = x => barTabs.reduce((best, t) => { const r = t.getBoundingClientRect(), d = Math.abs(x - (r.left + r.width / 2)); return !best || d < best.d ? { t, d } : best; }, null)?.t;
const setHot = t => barTabs.forEach(x => x.classList.toggle('hot', x === t));
function barEnd(go) {
  if (!barDrag) return;
  const target = go ? barDrag.hot : null;
  try { bar.releasePointerCapture(barDrag.id); } catch { /* already released */ }
  barDrag = null; bar.classList.remove('pressing', 'dragging'); setHot(null);
  if (!target) { syncInd(); return; }
  barClickAt = performance.now();
  placeInd(target);
  const href = target.getAttribute('href');
  if (location.hash !== href) location.hash = href;        // hashchange renders the page and re-syncs the bar
  else { window.scrollTo({ top: 0, behavior: 'smooth' }); syncInd(); }   // tapping the tab you're on scrolls to the top
}
bar.addEventListener('pointerdown', e => {
  if (barDrag || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const t = tabAt(e.clientX); if (!t) return;
  barDrag = { id: e.pointerId, x0: e.clientX, moved: false, hot: t };
  try { bar.setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
  bar.classList.add('pressing'); setHot(t); placeInd(t);    // instant feedback, before the page has even changed
});
bar.addEventListener('pointermove', e => {
  if (!barDrag || e.pointerId !== barDrag.id) return;
  if (!barDrag.moved && Math.abs(e.clientX - barDrag.x0) < 8) return;
  barDrag.moved = true; bar.classList.add('dragging');
  const r = bar.getBoundingClientRect(), w = barTabs[0].offsetWidth;
  const lo = barTabs[0].offsetLeft, hi = barTabs[barTabs.length - 1].offsetLeft;
  // Past either end the lens resists, like a rubber band
  let x = e.clientX - r.left - bar.clientLeft - w / 2;
  x = x < lo ? lo - Math.min(10, (lo - x) * 0.25) : x > hi ? hi + Math.min(10, (x - hi) * 0.25) : x;
  ind.style.setProperty('--x', x + 'px');
  const t = tabAt(e.clientX); if (t !== barDrag.hot) { barDrag.hot = t; setHot(t); }
});
bar.addEventListener('pointerup', e => { if (barDrag && e.pointerId === barDrag.id) barEnd(true); });
bar.addEventListener('pointercancel', e => { if (barDrag && e.pointerId === barDrag.id) barEnd(false); });
// The pointer handlers already navigated; this stops the link's own click from doing it twice. Keyboard clicks pass through.
bar.addEventListener('click', e => { if (performance.now() - barClickAt < 400) e.preventDefault(); });
bar.addEventListener('dragstart', e => e.preventDefault());
window.addEventListener('resize', () => syncInd(false));
document.fonts?.ready.then(() => syncInd(false));

/* ---------- dialogs ---------- */
const dlg = $('#dlg');
function openDlg(title, body, foot, onMount) {
  dlg.innerHTML = `<form method="dialog" id="dform" novalidate>
    <div class="dlg-h"><h3>${title}</h3><button class="iconbtn" type="button" data-act="close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4L12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z"/></svg></button></div>
    <div class="dlg-b">${body}</div>
    <div class="dlg-f">${foot}</div></form>`;
  dlg.classList.remove('wide');
  if (!dlg.open) dlg.showModal();
  onMount && onMount(dlg.querySelector('#dform'));
}
const closeDlg = () => { if (dlg.open) dlg.close(); };
dlg.addEventListener('click', e => { if (e.target === dlg) closeDlg(); }); // tap outside the sheet to close
function busy(form, on) { form.querySelectorAll('button[type=submit]').forEach(b => { b.disabled = on; }); }

function unlockDialog() {
  openDlg('Unlock editing', `
    <p style="margin:0;color:var(--muted);font-size:14px">Enter the league password to add players and log or fix matches. It's saved in this browser until you lock editing.</p>
    <label class="f" for="pw">League password<input id="pw" type="password" autocomplete="current-password"></label>
    <div class="err" id="pwErr" role="alert"></div>`,
    `<button class="btn" type="button" data-act="close">Cancel</button><button class="btn primary" type="submit">Unlock</button>`, form => {
      const i = form.querySelector('#pw'); i.focus();
      form.addEventListener('submit', async e => {
        e.preventDefault();
        if (!i.value) { form.querySelector('#pwErr').textContent = 'Enter the password.'; return; }
        busy(form, true);
        setPw(i.value);
        try { await api('GET', '/api/auth'); S.unlocked = true; closeDlg(); render(); toast('Editing unlocked.'); }
        catch (err) { setPw(''); form.querySelector('#pwErr').textContent = err.status === 401 ? 'That password is wrong.' : err.message; }
        busy(form, false);
      });
    });
}

function playerDialog(id) {
  const data = D(), p = id ? data.players[id] : null;
  const used = new Set(Object.values(data.players).map(x => x.color));
  const color = p ? p.color : (COLORS.find(c => !used.has(c)) || COLORS[Object.keys(data.players).length % COLORS.length]);
  openDlg(p ? 'Edit player' : 'Add a player', `
    <label class="f" for="pName">Name<input id="pName" type="text" maxlength="32" required value="${esc(p ? p.name : '')}" placeholder="What the group calls them"></label>
    <div class="row2">
      <label class="f" for="pTag">Player tag (needed for auto-tracking)<input id="pTag" type="text" maxlength="15" value="${esc(p ? p.tag : '')}" placeholder="#2PYQ8LV0"></label>
      <div class="f" style="display:grid;gap:6px;font-size:13px;font-weight:650;color:var(--muted)">Color
        <div class="swatches" role="radiogroup" aria-label="Profile color">${COLORS.map((c, i) => `<label><input type="radio" name="pColor" id="pColor${i}" value="${c}"${c === color ? ' checked' : ''} aria-label="Color ${i + 1}"><span style="background:${c}"></span></label>`).join('')}</div>
      </div>
    </div>
    <label class="f" for="pDeck">Main deck (optional)<textarea id="pDeck" rows="2" maxlength="160" placeholder="e.g. Hog 2.6, or the eight cards they always run">${esc(p ? p.deck : '')}</textarea></label>
    <div class="err" id="pErr" role="alert"></div>`,
    `<button class="btn" type="button" data-act="close">Cancel</button><button class="btn primary" type="submit">${p ? 'Save changes' : 'Add player'}</button>`,
    form => {
      form.querySelector('#pName').focus();
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const name = form.querySelector('#pName').value.trim();
        let tag = form.querySelector('#pTag').value.trim().toUpperCase().replace(/\s+/g, '').replace(/O/g, '0');
        const err = form.querySelector('#pErr');
        if (!name) { err.textContent = 'Give the player a name.'; return; }
        if (tag) { if (!tag.startsWith('#')) tag = '#' + tag; if (!/^#[0289CGJLPQRUVY]{3,14}$/.test(tag)) { err.textContent = 'Player tags use only 0 2 8 9 C G J L P Q R U V Y, like #2PYQ8LV0. Copy it from your in-game profile.'; return; } }
        const np = { id: id || undefined, name, tag, deck: form.querySelector('#pDeck').value.trim().slice(0, 160), color: (form.querySelector('input[name=pColor]:checked') || {}).value || color, archived: p ? p.archived : false };
        busy(form, true);
        if (await ops.putPlayer(np, !p)) { closeDlg(); toast(p ? 'Profile updated.' : `${name} joined the league.`); }
        busy(form, false);
      });
    });
}

function matchDialog(id, presetPlayer) {
  const data = D(), m = id ? data.matches[id] : null;
  const active = Object.values(data.players).filter(p => !p.archived || (m && (p.id === m.a || p.id === m.b))).sort((x, y) => x.name.localeCompare(y.name));
  if (active.length < 2) { toast('Add at least two players before logging a match.'); return; }
  const st = { a: m ? m.a : (presetPlayer || ''), b: m ? m.b : '', ca: m ? m.ca : 0, cb: m ? m.cb : 0, tie: m ? m.winner : 'draw' };
  const modes = m && !MODES.includes(m.mode) ? [m.mode, ...MODES] : MODES;
  const opts = sel => `<option value="">Choose player</option>` + active.map(p => `<option value="${esc(p.id)}"${sel === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  const crownCtl = side => `<div class="crowns" data-side="${side}">${[1, 2, 3].map(k => `<button type="button" data-crown="${k}" aria-label="${k} crown${k > 1 ? 's' : ''}">${CROWN}</button>`).join('')}</div>
    <div class="cnt" data-side="${side}" role="group" aria-label="Crowns">${[0, 1, 2, 3].map(k => `<button type="button" data-cnt="${k}">${k}</button>`).join('')}</div>`;
  openDlg(m ? 'Edit match' : 'Log a match', `
    ${m && m.source === 'api' ? '<p style="margin:0;font-size:13.5px;color:var(--muted)">This match was imported from the battle log. Your edits stick; it won’t be re-imported.</p>' : ''}
    <div class="board">
      <div class="team a"><div class="lbl">Blue side</div><select id="mA" aria-label="Blue side player">${opts(st.a)}</select>${crownCtl('a')}</div>
      <div class="vs">VS</div>
      <div class="team b"><div class="lbl">Red side</div><select id="mB" aria-label="Red side player">${opts(st.b)}</select>${crownCtl('b')}</div>
    </div>
    <div class="tb" id="tbBox" hidden>
      <span style="font-size:13.5px;color:var(--muted)">Crowns are level. How did it end?</span>
      <div class="opts">
        <label><input type="radio" name="tie" value="a">Blue won on tiebreaker</label>
        <label><input type="radio" name="tie" value="draw">Draw</label>
        <label><input type="radio" name="tie" value="b">Red won on tiebreaker</label>
      </div>
    </div>
    <div class="row2">
      <label class="f" for="mWhen">Played<input id="mWhen" type="datetime-local" value="${toLocalInput(m ? m.playedAt : Date.now())}"></label>
      <label class="f" for="mMode">Mode<select id="mMode">${modes.map(x => `<option${(m ? m.mode : 'Classic') === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
    </div>
    <label class="f" for="mNotes">Notes (optional)<input id="mNotes" type="text" maxlength="200" value="${esc(m ? m.notes : '')}" placeholder="Last-second log bait, rematch tomorrow…"></label>
    <label class="check" for="mRanked"><input id="mRanked" type="checkbox"${!m || m.ranked ? ' checked' : ''}> Counts toward RP</label>
    <div class="preview" id="mPrev" aria-live="polite"></div>
    <div class="err" id="mErr" role="alert"></div>`,
    `<button class="btn" type="button" data-act="close">Cancel</button><button class="btn primary" type="submit">${m ? 'Save match' : 'Log match'}</button>`,
    form => {
      const q = s => form.querySelector(s);
      const build = () => {
        const t = new Date(q('#mWhen').value).getTime();
        const winner = st.ca !== st.cb ? (st.ca > st.cb ? 'a' : 'b') : st.tie;
        return {
          id: m ? m.id : '__preview', a: st.a, b: st.b, ca: st.ca, cb: st.cb, winner,
          playedAt: Number.isFinite(t) ? t : Date.now(), createdAt: m ? m.createdAt : Date.now(),
          ranked: q('#mRanked').checked, mode: q('#mMode').value, notes: q('#mNotes').value.trim(),
          source: m ? m.source : 'manual',
        };
      };
      const paint = () => {
        ['a', 'b'].forEach(side => {
          const n = st['c' + side];
          form.querySelectorAll(`.crowns[data-side=${side}] button`).forEach(b => b.classList.toggle('on', +b.dataset.crown <= n));
          form.querySelectorAll(`.cnt[data-side=${side}] button`).forEach(b => { const on = +b.dataset.cnt === n; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
        });
        q('#tbBox').hidden = st.ca !== st.cb;
        form.querySelectorAll('input[name=tie]').forEach(r => { r.checked = r.value === st.tie; });
        const prev = q('#mPrev');
        if (!st.a || !st.b || st.a === st.b) { prev.innerHTML = 'Pick two different players to see the RP change.'; return; }
        const nm = build();
        if (!nm.ranked) { prev.innerHTML = 'This match is recorded but won’t change anyone’s RP.'; return; }
        // Replay the league with this match in it to get the exact change, season resets included.
        const sim = league({ players: D().players, matches: { ...D().matches, [nm.id]: nm } });
        const dl = sim.byKey[seasonKey(nm.playedAt, tz())]?.delta[nm.id];
        if (!dl) { prev.innerHTML = 'Pick a date that isn’t in the future.'; return; }
        const A = D().players[st.a], B = D().players[st.b];
        const chg = (name, rpd, rp0) => `<b>${esc(name)}</b> ${rpd != null ? `<span class="${dCls(rpd)}">${fmtD(rpd)}</span> RP (from ${R(rp0)})` : '<span class="muted">placing</span>'}`;
        prev.innerHTML = `Win chance before: <b>${esc(A.name)}</b> ${fmtPct(dl.pA)} · <b>${esc(B.name)}</b> ${fmtPct(1 - dl.pA)}<br>Change: ${chg(A.name, dl.rpA, dl.rp.a0)} · ${chg(B.name, dl.rpB, dl.rp.b0)}`;
      };
      form.addEventListener('click', e => {
        const c = e.target.closest('[data-crown]'), n = e.target.closest('[data-cnt]');
        if (c) { const side = c.parentElement.dataset.side, k = +c.dataset.crown; st['c' + side] = st['c' + side] === k ? k - 1 : k; paint(); }
        if (n) { st['c' + n.parentElement.dataset.side] = +n.dataset.cnt; paint(); }
      });
      form.addEventListener('change', e => {
        if (e.target.id === 'mA') st.a = e.target.value;
        if (e.target.id === 'mB') st.b = e.target.value;
        if (e.target.name === 'tie') st.tie = e.target.value;
        paint();
      });
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const err = q('#mErr');
        if (!st.a || !st.b) { err.textContent = 'Choose a player for both sides.'; return; }
        if (st.a === st.b) { err.textContent = 'A player can’t battle themselves. Pick two different players.'; return; }
        if (!q('#mWhen').value) { err.textContent = 'Add the date and time it was played.'; return; }
        const nm = build();
        if (!m) delete nm.id;
        delete nm.createdAt; delete nm.source;
        busy(form, true);
        const ok = await ops.putMatch(m ? nm : (S.demo ? { ...nm, createdAt: Date.now() } : nm), !m);
        busy(form, false);
        if (ok) {
          closeDlg();
          const A = D().players[nm.a], B = D().players[nm.b];
          toast(nm.winner === 'draw' ? `Draw logged: ${A.name} vs ${B.name}.` : `${(nm.winner === 'a' ? A : B).name} wins ${Math.max(nm.ca, nm.cb)}–${Math.min(nm.ca, nm.cb)}. Logged.`);
        }
      });
      paint();
      (st.a ? (st.b ? q('[data-cnt="1"]') : q('#mB')) : q('#mA')).focus();
    });
}

function confirmDlg(title, text, label, fn) {
  openDlg(title, `<p style="margin:0">${text}</p>`, `<button class="btn" type="button" data-act="close">Cancel</button><button class="btn danger" type="submit">${label}</button>`, form => {
    form.addEventListener('submit', async e => { e.preventDefault(); busy(form, true); if (await fn()) closeDlg(); busy(form, false); });
  });
}

function leagueDialog() {
  openDlg('Rename league', `<label class="f" for="lName">League name<input id="lName" type="text" maxlength="40" value="${esc(D().league.name || '')}"></label><div class="err" id="lErr" role="alert"></div>`,
    `<button class="btn" type="button" data-act="close">Cancel</button><button class="btn primary" type="submit">Save</button>`, form => {
      const i = form.querySelector('#lName'); i.focus(); i.select();
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const name = i.value.trim();
        if (!name) { form.querySelector('#lErr').textContent = 'The league needs a name.'; return; }
        if (name === D().league.name) { closeDlg(); return; }
        if (await ops.putLeague({ name })) closeDlg();
      });
    });
}

function importDialog() {
  openDlg('Import league data', `
    <p style="margin:0;color:var(--muted);font-size:14px">Paste JSON from “Copy data as JSON” (this site or the original Claude page). Players and matches that already exist are skipped, so it's safe to run twice.</p>
    <label class="f" for="imp">JSON<textarea id="imp" rows="9" spellcheck="false" style="font-family:ui-monospace,Menlo,monospace;font-size:12.5px"></textarea></label>
    <div class="err" id="impErr" role="alert"></div>`,
    `<button class="btn" type="button" data-act="close">Cancel</button><button class="btn primary" type="submit">Import</button>`, form => {
      form.querySelector('#imp').focus();
      form.addEventListener('submit', async e => {
        e.preventDefault();
        let body;
        try { body = JSON.parse(form.querySelector('#imp').value); } catch { form.querySelector('#impErr').textContent = "That isn't valid JSON. Paste the whole export."; return; }
        busy(form, true);
        try {
          const r = await api('POST', '/api/import', body);
          await refresh(); closeDlg();
          toast(`Imported ${r.players} players and ${r.matches} matches${r.skipped ? `, skipped ${r.skipped}` : ''}.`);
        } catch (err) { form.querySelector('#impErr').textContent = err.message; }
        busy(form, false);
      });
    });
}

/* ---------- sample data (memory only) ---------- */
function makeDemo() {
  let seed = 7; const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  // Sample decks use names and elixir only (no icons), so cards show as lettered tiles.
  const C = (name, elixir, rarity = 'common', evo = false) => ({ id: name, name, elixir, rarity, icon: '', evo });
  const decks = [
    [C('Hog Rider', 4, 'rare'), C('The Log', 2, 'legendary'), C('Ice Spirit', 1), C('Skeletons', 1, 'common', true), C('Ice Golem', 2, 'rare'), C('Fireball', 4, 'rare'), C('Musketeer', 4, 'rare'), C('Cannon', 3)],
    [C('Golem', 8, 'epic'), C('Night Witch', 4, 'legendary'), C('Lumberjack', 4, 'legendary'), C('Electro Dragon', 5, 'epic'), C('Zap', 2), C('Baby Dragon', 4, 'epic'), C('Tornado', 3, 'epic'), C('Lightning', 6, 'epic')],
    [C('X-Bow', 6, 'epic'), C('Tesla', 4), C('Archers', 3, 'common', true), C('Knight', 3, 'common', true), C('Fireball', 4, 'rare'), C('The Log', 2, 'legendary'), C('Ice Spirit', 1), C('Skeletons', 1)],
    [C('Goblin Barrel', 3, 'epic'), C('Princess', 3, 'legendary'), C('Goblin Gang', 3), C('Knight', 3), C('Inferno Tower', 5, 'rare'), C('Rocket', 6, 'rare'), C('The Log', 2, 'legendary'), C('Ice Spirit', 1)],
    [C('Royal Giant', 6), C('Fisherman', 3, 'legendary'), C('Hunter', 4, 'epic'), C('Lightning', 6, 'epic'), C('The Log', 2, 'legendary'), C('Electro Spirit', 1), C('Skeletons', 1), C('Mother Witch', 4, 'legendary')],
    [C('Lava Hound', 7, 'legendary'), C('Balloon', 5, 'epic'), C('Mega Minion', 3, 'rare'), C('Minions', 3), C('Arrows', 3), C('Zap', 2), C('Tombstone', 3, 'rare'), C('Skeleton Dragons', 4)],
  ];
  const deck = i => ({ cards: decks[i].map(c => ({ ...c })), tower: { id: 't', name: 'Tower Princess', icon: '' } });
  // Towers this side lost = crowns the other side took; losers tend to leak more elixir.
  const demoSide = (lost, lostGame) => ({
    leaked: Math.round((rnd() * (lostGame ? 6 : 3.5)) * 100) / 100,
    king: lost >= 3 ? null : Math.round(4824 - (rnd() < 0.35 ? rnd() * 2400 : 0)),
    princess: Array.from({ length: Math.max(0, 2 - Math.min(lost, 2)) }, () => Math.round(3052 * (0.1 + 0.9 * rnd()))),
  });
  const names = [['Ava', '#Q8RL2YJ', 'Hog 2.6 Cycle'], ['Ben', '#2PYQ8LV0', 'Golem Beatdown'], ['Chloe', '#9VUG0P', 'X-Bow 3.0'], ['Dev', '', 'Log Bait'], ['Eli', '#LJC22Q', 'Royal Giant Fisherman'], ['Fern', '#8CUY02', 'Lava Loon']];
  const skill = [1680, 1610, 1550, 1500, 1460, 1400];
  const now = Date.now(), dayMs = 864e5, span = 75;
  const players = {}, ids = [];
  names.forEach((n, i) => { const id = 'demo' + i; ids.push(id); players[id] = { id, name: n[0], tag: n[1], deck: n[2], color: COLORS[i], archived: false, createdAt: now - (span + 5) * dayMs, ladder: n[1] ? { trophies: 9000 - i * 650, best: 9400 - i * 500, at: now - 20 * 60000 } : null }; });
  const matches = {};
  const N = 120;
  for (let k = 0; k < N; k++) {
    let i = Math.floor(rnd() * 6), j = Math.floor(rnd() * 5); if (j >= i) j++;
    const pa = 1 / (1 + Math.pow(10, (skill[j] - skill[i]) / 400));
    const t = now - (span - (k / N) * span) * dayMs + Math.floor(rnd() * 5) * 36e5;
    let ca, cb, winner;
    if (rnd() < 0.07) { ca = cb = Math.floor(rnd() * 2); winner = rnd() < 0.5 ? 'draw' : (rnd() < pa ? 'a' : 'b'); }
    else {
      const aWins = rnd() < pa; const wc = rnd() < 0.45 ? 1 : rnd() < 0.55 ? 2 : 3; const lc = Math.floor(rnd() * wc);
      ca = aWins ? wc : lc; cb = aWins ? lc : wc; winner = aWins ? 'a' : 'b';
    }
    const id = 'dm' + k;
    const auto = !!(players[ids[i]].tag && players[ids[j]].tag) && rnd() < 0.85;
    // Players mostly stick to their main deck and sometimes borrow someone else's.
    const pick = p => (rnd() < 0.8 ? p : Math.floor(rnd() * 6));
    matches[id] = { id, a: ids[i], b: ids[j], ca, cb, winner, playedAt: Math.min(t, now - 36e5), createdAt: t, ranked: true,
      mode: rnd() < 0.7 ? 'Classic' : MODES[1 + Math.floor(rnd() * 3)], notes: '', source: auto ? 'api' : 'manual',
      deckA: auto ? deck(pick(i)) : null, deckB: auto ? deck(pick(j)) : null,
      stats: auto ? { a: demoSide(cb, winner === 'b'), b: demoSide(ca, winner === 'a') } : null };
  }
  return { players, matches, league: { name: 'Sample League' } };
}

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const row = e.target.closest('tr[data-href]');
  if (row && !e.target.closest('a,button')) { if (dlg.contains(row)) closeDlg(); location.hash = row.dataset.href; return; }
  if (e.target.closest('.st-full a[href^="#p-"]')) closeDlg();   // player links inside the full standings sheet
  const b = e.target.closest('[data-act]');
  if (!b) {
    const row = e.target.closest('.match[data-match]');
    if (row && !e.target.closest('a,button,select') && !dlg.open) matchDetail(row.dataset.match);
    return;
  }
  const act = b.dataset.act, id = b.dataset.id, data = D();
  if (act === 'close') { closeDlg(); return; }
  if (act === 'standings-full') { standingsFull(); return; }
  if (act === 'close-nav') { closeDlg(); return; } // link inside the sheet: close it and let the link navigate
  if (act === 'details') { matchDetail(id); return; }
  if (act === 'enter') { enterLeague(); return; }
  if (act === 'enter-to') { e.preventDefault(); enterLeague(b.dataset.href); return; }
  if (act === 'demo-on') { S.demo = makeDemo(); S.season = ''; location.hash = '#standings'; render(); return; }
  if (act === 'demo-off') { S.demo = null; S.season = ''; render(); return; }
  if (act === 'sort') {
    // Click cycles: column's natural direction -> reversed -> back to placement order.
    const key = b.dataset.key, cur = S.sort;
    if (key === 'rank') S.sort = cur.key === null ? { key: 'rank', dir: 'desc' } : { key: null, dir: 'desc' };
    else if (cur.key !== key) S.sort = { key, dir: SORT_KEYS[key].dir };
    else if (cur.dir === SORT_KEYS[key].dir) S.sort = { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
    else S.sort = { key: null, dir: 'desc' };
    render();
    const box = dlg.open && dlg.querySelector('.st-full');
    if (box && lastStandings) { box.innerHTML = lastStandings.tbl; pinStandings(); }
    (box || document).querySelector(`th [data-key="${key}"]`)?.focus();
    return;
  }
  if (act === 'more') { S.matchLimit += 50; render(); return; }
  if (act === 'recap-dl') {
    const blob = recapReady || await recapBlob();
    if (!blob) { toast("Couldn't make the image. Try reloading the page."); return; }
    const name = `recap-${new Date().toLocaleDateString('en-CA')}.png`; // en-CA gives YYYY-MM-DD in local time
    // Phones: the share sheet (Save Image, Messages, ...). A download link does nothing in an iPhone home-screen app.
    const file = new File([blob], name, { type: 'image/png' });
    if (TOUCH.matches && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Weekly recap' }); return; }
      catch (err) { if (err.name === 'AbortError') return; /* otherwise fall through to a download */ }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000); return;
  }
  if (act === 'recap-copy') {
    // Hand over the finished image when we have it (Chrome can stall on a still-pending one); Safari needs write() called
    // right away in the tap, which the pending-promise form allows when it isn't ready yet.
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': recapReady || recapBlob() })]); toast('Recap image copied. Paste it in the group chat.'); }
    catch { toast("Couldn't copy the image here. Use Download instead."); }
    return;
  }
  if (act === 'run-tune') {
    b.disabled = true; b.textContent = 'Running…';
    setTimeout(() => {
      const t0 = performance.now();
      S.tune = { sig: labSig(D()), res: tune(D(), { tz: tz(), now: Date.now() }) };
      S.tune.ms = performance.now() - t0;
      render();
    }, 30);
    return;
  }
  if (act === 'unlock') { unlockDialog(); return; }
  if (act === 'copy-json') {
    const out = JSON.stringify({ league: data.league, players: Object.values(data.players), matches: Object.values(data.matches) }, null, 2);
    try { await navigator.clipboard.writeText(out); toast('League data copied to your clipboard.'); }
    catch { toast("Couldn't copy. Your browser blocked clipboard access."); }
    return;
  }
  if (act === 'sync') {
    if (!writable() || S.demo) { toast(S.sync?.lastError || `Battle logs are checked every ${S.sync?.intervalMinutes ?? 10} minutes.`); return; }
    if (S.sync) S.sync.running = true; renderSync();
    try {
      const st = await api('POST', '/api/sync');
      await refresh();
      const r = st.lastResult || {};
      toast(st.lastError ? st.lastError : `Synced. ${r.inserted || 0} new match${r.inserted === 1 ? '' : 'es'}${r.linked ? `, ${r.linked} merged with ones you logged` : ''}.`);
    } catch (err) { await refresh(); toast(err.message); }
    return;
  }
  if (!writable()) return;
  if (act === 'lock') { setPw(''); S.unlocked = false; render(); toast('Editing locked on this browser.'); }
  else if (act === 'add-player') playerDialog();
  else if (act === 'edit-player') playerDialog(id);
  else if (act === 'log') matchDialog(null, id);
  else if (act === 'edit-match') matchDialog(id);
  else if (act === 'rename-league') leagueDialog();
  else if (act === 'import-json') importDialog();
  else if (act === 'del-match') {
    const m = data.matches[id]; if (!m) return;
    const A = data.players[m.a], B = data.players[m.b];
    confirmDlg('Delete match?', `${esc(A ? A.name : '?')} ${m.ca}–${m.cb} ${esc(B ? B.name : '?')} on ${esc(fmtDate(m.playedAt, false))}. Ratings will be recalculated without it.${m.source === 'api' ? ' It won’t be re-imported.' : ''}`, 'Delete match', () => ops.delMatch(id));
  }
  else if (act === 'retire' || act === 'restore') {
    const p = data.players[id];
    if (p && await ops.putPlayer({ id, archived: act === 'retire' }, false)) toast(act === 'retire' ? `${p.name} is retired. Their matches still count.` : `${p.name} is back in the standings.`);
  }
  else if (act === 'del-player') {
    const p = data.players[id]; if (!p) return;
    confirmDlg('Delete player?', `${esc(p.name)} has no matches, so nothing else changes.`, 'Delete player', async () => { const ok = await ops.delPlayer(id); if (ok) location.hash = '#standings'; return ok; });
  }
});
document.addEventListener('change', e => {
  const id = e.target.id;
  if (id === 'filterSel') { S.filter = e.target.value; S.matchLimit = 50; render(); }
  else if (id === 'seasonSel') { S.season = e.target.value; S.matchLimit = 50; render(); }
  else if (id === 'predA' || id === 'predB') {
    const v = e.target.value, other = id === 'predA' ? 'pb' : 'pa', mine = id === 'predA' ? 'pa' : 'pb';
    if (S[other] === v) S[other] = S[mine]; // picking the same player swaps the sides
    S[mine] = v; S.matchLimit = 50;
    history.replaceState(null, '', pairHash(S.pa, S.pb)); // shareable link to this rivalry
    render();
  }
});

/* ---------- boot ---------- */
(async () => {
  render();
  await refresh();
  if (S.editable && getPw()) {
    try { await api('GET', '/api/auth'); S.unlocked = true; } catch { setPw(''); }
    render();
  }
  // Pick up auto-imported matches without a reload. Skip while a dialog is open so forms aren't disturbed.
  setInterval(() => { if (!document.hidden && !dlg.open && !S.demo) refresh(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !S.demo) refresh(); });
  setInterval(renderSync, 30000);
})();
