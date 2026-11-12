import { START, PROV, compute, tier, ranking, pct } from './elo.js';

/* ---------- constants ---------- */
const MODES = ['Classic', 'Triple Elixir', 'Draft', 'Sudden Death', 'Mega Deck', 'Other'];
const COLORS = ['#4a90ff', '#ff5367', '#ffc63a', '#3fd68f', '#b783ff', '#ff8a3d', '#2fd3e0', '#ff74be'];
const CROWN = '<svg class="crown" viewBox="0 0 24 20" aria-hidden="true"><path d="M2 6l5 4 5-8 5 8 5-4-2 11H4z"/><rect x="4" y="17" width="16" height="2.5" rx="1"/></svg>';
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
  const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  return withTime ? { day, time: d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) } : day;
}
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
function normalize(payload) {
  const players = {}, matches = {};
  for (const p of payload.players || []) players[p.id] = p;
  for (const m of payload.matches || []) matches[m.id] = m;
  return { players, matches, league: payload.league || { name: 'Friendly Battle League' } };
}
async function refresh() {
  try {
    const payload = await api('GET', '/api/league');
    S.data = normalize(payload);
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
  render(); return Promise.resolve(true);
}
function demoDel(coll, id) { delete S.demo[coll][id]; render(); return Promise.resolve(true); }

/* ---------- small renderers ---------- */
const avatar = (p, lg) => `<span class="av${lg ? ' lg' : ''}" style="background:${esc(p.color)}" aria-hidden="true">${esc(initials(p.name))}</span>`;
const formHtml = f => f.length ? `<span class="form" aria-label="Last ${f.length}: ${f.join(' ')}">${f.map(r => `<i class="${r}">${r}</i>`).join('')}</span>` : '<span class="muted">—</span>';
const streakHtml = s => s.streakN >= 1 && s.streakT ? `<span class="chip streak ${s.streakT}">${s.streakT}${s.streakN}</span>` : '<span class="muted">—</span>';
function spark(vals, w = 96, h = 28) {
  if (vals.length < 3) return '<span class="muted">—</span>';
  const v = vals.slice(-15), mn = Math.min(...v), mx = Math.max(...v), span = Math.max(mx - mn, 12), mid = (mx + mn) / 2;
  const pts = v.map((y, i) => [2 + (i / (v.length - 1)) * (w - 6), h / 2 - ((y - mid) / span) * (h - 8)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
  const L = pts[pts.length - 1], up = v[v.length - 1] >= v[0];
  return `<svg class="spark ${up ? 'up' : 'down'}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Rating trend, last ${v.length} rated matches"><path class="sa" d="${d}L${L[0].toFixed(1)} ${h}L2 ${h}Z"/><path class="sl" d="${d}"/><circle cx="${L[0].toFixed(1)}" cy="${L[1].toFixed(1)}" r="2.6"/></svg>`;
}
function bigChart(vals) {
  const W = 640, H = 230, l = 46, r = 18, t = 14, b = 30;
  if (vals.length < 2) return '<p class="muted" style="margin:0">The rating chart shows up after the first rated match.</p>';
  const mnV = Math.min(...vals), mxV = Math.max(...vals);
  const step = (mxV - mnV) > 300 ? 100 : 50;
  let lo = Math.floor((mnV - 10) / step) * step, hi = Math.ceil((mxV + 10) / step) * step;
  if (hi - lo < step * 2) { lo -= step; hi += step; }
  const x = i => l + (i / (vals.length - 1)) * (W - l - r);
  const y = v => t + (1 - (v - lo) / (hi - lo)) * (H - t - b);
  let g = '';
  for (let v = lo; v <= hi; v += step) g += `<line class="grid" x1="${l}" x2="${W - r}" y1="${y(v)}" y2="${y(v)}"/><text x="${l - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  const base = START > lo && START < hi ? `<line class="base" x1="${l}" x2="${W - r}" y1="${y(START)}" y2="${y(START)}"/>` : '';
  const d = vals.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join('');
  const n = vals.length - 1;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rating over ${n} rated matches, from ${R(vals[0])} to ${R(vals[n])}">
    <defs><linearGradient id="gfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc63a" stop-opacity=".28"/><stop offset="1" stop-color="#ffc63a" stop-opacity="0"/></linearGradient></defs>
    ${g}${base}
    <path class="area" d="${d}L${x(n).toFixed(1)} ${H - b}L${l} ${H - b}Z"/>
    <path class="line" d="${d}"/>
    <circle class="end" cx="${x(n).toFixed(1)}" cy="${y(vals[n]).toFixed(1)}" r="5"/>
    <text x="${l}" y="${H - 8}">Start</text>
    <text x="${W - r}" y="${H - 8}" text-anchor="end">Match ${n}</text>
  </svg>`;
}
function matchRow(m, data, C) {
  const A = data.players[m.a], B = data.players[m.b], dl = C.delta[m.id] || {};
  const when = fmtDate(m.playedAt);
  const tieNote = m.ca === m.cb ? (m.winner === 'draw' ? 'Draw' : 'Tiebreaker') : '';
  const side = (p, cls, won, d) => `<div class="side ${cls}${won ? ' won' : ''}">
      ${cls === 'b' && d != null ? `<span class="dl ${dCls(d)}">${fmtD(d)}</span>` : ''}
      ${won && cls === 'b' ? CROWN : ''}
      <a href="#p-${esc(p.id)}">${esc(p.name)}</a>
      ${won && cls === 'a' ? CROWN : ''}
      ${cls === 'a' && d != null ? `<span class="dl ${dCls(d)}">${fmtD(d)}</span>` : ''}
    </div>`;
  const acts = writable() ? `<div class="row-acts">
      <button class="iconbtn" type="button" data-act="edit-match" data-id="${esc(m.id)}" aria-label="Edit match">${ICON_EDIT}</button>
      <button class="iconbtn" type="button" data-act="del-match" data-id="${esc(m.id)}" aria-label="Delete match">${ICON_DEL}</button></div>` : '<div class="row-acts"></div>';
  return `<div class="match">
    <div class="when"><b>${esc(when.day)}${m.source === 'api' ? '<span class="auto" title="Imported from the Clash Royale battle log">Auto</span>' : ''}</b>${esc(when.time)} · ${esc(m.mode)}${m.ranked ? '' : ' · <span class="unranked">unrated</span>'}${m.notes ? `<br>${esc(m.notes)}` : ''}</div>
    ${side(A, 'a', m.winner === 'a', dl.a)}
    <div class="score-wrap"><div class="score num"><span class="a">${m.ca}</span><span class="dash">–</span><span class="b">${m.cb}</span></div>${tieNote ? `<div class="score-note">${tieNote}</div>` : ''}</div>
    ${side(B, 'b', m.winner === 'b', dl.b)}
    ${acts}
  </div>`;
}

/* ---------- views ---------- */
function viewEmpty() {
  return `<section class="panel empty">
    <div class="eyebrow">New league</div>
    <h2>Add your crew, then go play some friendlies</h2>
    <p>Add each friend with their player tag. Every few minutes the server checks everyone's battle log and imports friendlies between league members automatically, then updates ratings, streaks and rivalries.</p>
    <div class="steps">
      <div><b>1. Add players</b><span>Name plus player tag (in-game: tap your profile, the tag starts with #).</span></div>
      <div><b>2. Play friendlies</b><span>1v1 friendly battles between two league members get picked up on their own.</span></div>
      <div><b>3. Climb</b><span>You can still log or fix matches by hand at any time.</span></div>
    </div>
    <div class="actions">
      ${writable() ? '<button class="btn primary" type="button" data-act="add-player">Add the first player</button>' : (S.editable ? '<button class="btn primary" type="button" data-act="unlock">Unlock editing</button>' : '')}
      <button class="btn" type="button" data-act="demo-on">Preview with sample data</button>
    </div>
  </section>`;
}
function viewStandings(data, C) {
  const rows = ranking(data, C);
  if (!rows.length) return viewEmpty();
  const played = rows.filter(p => C.st[p.id].games > 0);
  const leader = played[0];
  let hot = null; for (const p of rows) { const s = C.st[p.id]; if (s.streakT === 'W' && s.streakN >= 2 && (!hot || s.streakN > C.st[hot.id].streakN)) hot = p; }
  const pairs = {}; for (const m of C.ms) { const k = [m.a, m.b].sort().join('|'); pairs[k] = (pairs[k] || 0) + 1; }
  let top = null; for (const k in pairs) if (!top || pairs[k] > pairs[top]) top = k;
  const auto = C.ms.filter(m => m.source === 'api').length;
  const strip = `<section class="strip" aria-label="League summary">
    <div><div class="k">Matches logged</div><div class="v num">${C.ms.length}</div><div class="s">${auto} auto-imported · ${rows.length} active players</div></div>
    <div><div class="k">League leader</div><div class="v">${leader ? esc(leader.name) : '—'}</div><div class="s">${leader ? R(C.st[leader.id].rating) + ' · ' + tier(C.st[leader.id]).name : 'No matches yet'}</div></div>
    <div><div class="k">On fire</div><div class="v">${hot ? esc(hot.name) : '—'}</div><div class="s">${hot ? C.st[hot.id].streakN + ' wins in a row' : 'Nobody on a 2+ win streak'}</div></div>
    <div><div class="k">Biggest rivalry</div><div class="v">${top ? top.split('|').map(id => esc(data.players[id].name)).join(' <span class="muted">vs</span> ') : '—'}</div><div class="s">${top ? pairs[top] + (pairs[top] === 1 ? ' battle' : ' battles') : 'Play a friendly to start one'}</div></div>
  </section>`;
  const body = rows.map((p, i) => {
    const s = C.st[p.id], t = tier(s), rk = s.games ? i + 1 : '–';
    return `<tr class="link" data-href="#p-${esc(p.id)}">
      <td class="rank${rk === 1 ? ' first' : ''}">${rk === 1 ? CROWN : ''}${rk}</td>
      <td><a class="pl" href="#p-${esc(p.id)}">${avatar(p)}<span style="min-width:0"><span class="nm" style="display:block">${esc(p.name)}</span>${p.tag ? `<span class="tag">${esc(p.tag)}</span>` : '<span class="tag">No tag, not auto-tracked</span>'}</span></a></td>
      <td><span class="rating num">${R(s.rating)}</span>${s.last != null ? `<span class="delta ${dCls(s.last)}">${fmtD(s.last)}</span>` : ''}</td>
      <td class="hide-sm"><span class="chip ${t.cls}">${t.name}</span></td>
      <td class="num">${s.w}-${s.l}${s.d ? '-' + s.d : ''}</td>
      <td class="num r hide-sm">${pct(s)}</td>
      <td class="num r hide-md">${s.games ? (s.cf / s.games).toFixed(1) : '—'}</td>
      <td class="hide-sm">${streakHtml(s)}</td>
      <td class="hide-md">${formHtml(s.form)}</td>
      <td class="hide-md">${spark(s.hist)}</td>
    </tr>`;
  }).join('');
  const retired = Object.values(data.players).filter(p => p.archived);
  return strip + `<section class="panel">
    <div class="panel-h"><h2>Standings</h2><span class="muted" style="font-size:13px">Click a player for their profile</span></div>
    <div class="panel-b table-wrap" style="padding-top:6px">
      <table>
        <thead><tr><th>#</th><th>Player</th><th>Rating</th><th class="hide-sm">Tier</th><th>W-L</th><th class="r hide-sm">Win %</th><th class="r hide-md">Crowns/g</th><th class="hide-sm">Streak</th><th class="hide-md">Last 5</th><th class="hide-md">Trend</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    ${retired.length ? `<div class="panel-b muted" style="padding-top:0;font-size:13.5px">Retired: ${retired.map(p => `<a href="#p-${esc(p.id)}">${esc(p.name)}</a>`).join(', ')}</div>` : ''}
  </section>`;
}
function viewMatches(data, C) {
  const players = Object.values(data.players).sort((a, b) => a.name.localeCompare(b.name));
  if (!players.length) return viewEmpty();
  if (S.filter && !data.players[S.filter]) S.filter = '';
  const list = C.ms.filter(m => !S.filter || m.a === S.filter || m.b === S.filter).slice().reverse();
  return `<section class="panel">
    <div class="panel-h"><h2>Match log</h2>
      <div class="filters"><label for="filterSel" class="muted" style="font-size:13px">Show</label>
        <select id="filterSel"><option value="">All players</option>${players.map(p => `<option value="${esc(p.id)}"${S.filter === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      </div>
    </div>
    <div class="panel-b">
      ${list.length ? `<div class="mlist">${list.map(m => matchRow(m, data, C)).join('')}</div>` :
        `<p class="muted" style="margin:6px 0 0">No matches yet${S.filter ? ' for this player' : ''}. Friendlies between tagged players show up here automatically.</p>`}
    </div>
  </section>`;
}
function viewRivalries(data, C) {
  const rows = ranking(data, C).filter(p => C.st[p.id].games > 0);
  if (rows.length < 2) return `<section class="panel"><div class="panel-h"><h2>Rivalries</h2></div><div class="panel-b"><p class="muted" style="margin:0">Head-to-head records appear once at least two players have battled.</p></div></section>`;
  const head = rows.map(p => `<th title="${esc(p.name)}">${avatar(p)}</th>`).join('');
  const body = rows.map(r => `<tr><th class="rowh"><a class="pl" href="#p-${esc(r.id)}">${avatar(r)}<span class="nm">${esc(r.name)}</span></a></th>${rows.map(c => {
    if (c.id === r.id) return '<td class="self">·</td>';
    const h = C.st[r.id].h2h[c.id];
    if (!h) return '<td class="muted">—</td>';
    const share = (h.w + 0.5 * h.d) / h.n;
    const bg = share > .5 ? `rgba(63,214,143,${(.12 + (share - .5) * .7).toFixed(2)})` : share < .5 ? `rgba(242,123,139,${(.12 + (.5 - share) * .7).toFixed(2)})` : 'rgba(154,166,201,.15)';
    return `<td class="cell num" style="background:${bg}" title="${esc(r.name)} vs ${esc(c.name)}: ${h.w}W ${h.l}L${h.d ? ' ' + h.d + 'D' : ''}">${h.w}-${h.l}${h.d ? '-' + h.d : ''}</td>`;
  }).join('')}</tr>`).join('');
  return `<section class="panel">
    <div class="panel-h"><h2>Rivalries</h2><span class="muted" style="font-size:13px">Row player's record against each column player</span></div>
    <div class="panel-b table-wrap"><table class="matrix"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div>
  </section>`;
}
function viewPlayer(id, data, C) {
  const p = data.players[id];
  if (!p) return `<section class="panel"><div class="panel-b"><p style="margin:0">That player isn't in this league. <a href="#standings">Back to standings</a></p></div></section>`;
  const s = C.st[id], t = tier(s);
  const order = ranking(data, C); const pos = order.findIndex(x => x.id === id);
  const rankTxt = p.archived ? 'Retired' : s.games ? `#${pos + 1} of ${order.filter(x => C.st[x.id].games).length}` : 'Unranked';
  const mine = C.ms.filter(m => m.a === id || m.b === id);
  let best = null;
  for (const m of mine) {
    const isA = m.a === id, won = m.winner === (isA ? 'a' : 'b');
    if (!won) continue;
    const opp = C.delta[m.id][isA ? 'preB' : 'preA'];
    if (!best || opp > best.r) best = { r: opp, oppId: isA ? m.b : m.a };
  }
  const h2h = Object.entries(s.h2h).sort((a, b) => b[1].n - a[1].n);
  const w = writable();
  return `<a class="back" href="#standings">← Standings</a>
  <section class="panel">
    <div class="hero">
      ${avatar(p, true)}
      <div class="who">
        <h2>${esc(p.name)}</h2>
        <div class="meta"><span class="chip ${t.cls}">${t.name}</span><span>${rankTxt}</span>${p.tag ? `<span>· ${esc(p.tag)}</span><span class="chip track on">Auto-tracked</span>` : '<span class="chip track">No tag, not auto-tracked</span>'}<span>· Joined ${esc(fmtDate(p.createdAt, false))}</span></div>
      </div>
      <div class="big"><div class="k">Rating</div><div class="rating num">${R(s.rating)}</div><div class="muted" style="font-size:13px">Peak ${R(s.peak)}${s.last != null ? ` · last <span class="${dCls(s.last)}">${fmtD(s.last)}</span>` : ''}</div></div>
      ${w ? `<div class="tools">
        <button class="btn small" type="button" data-act="log" data-id="${esc(id)}">Log a match</button>
        <button class="btn small" type="button" data-act="edit-player" data-id="${esc(id)}">Edit profile</button>
        ${p.archived ? `<button class="btn small" type="button" data-act="restore" data-id="${esc(id)}">Bring back</button>` : `<button class="btn small" type="button" data-act="retire" data-id="${esc(id)}">Retire</button>`}
        ${mine.length === 0 ? `<button class="btn small danger" type="button" data-act="del-player" data-id="${esc(id)}">Delete</button>` : ''}
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
    </div>
  </section>
  <div class="grid2">
    <section class="panel">
      <div class="panel-h"><h2>Rating history</h2>${best ? `<span class="muted" style="font-size:13px">Best win: ${esc(data.players[best.oppId].name)} at ${R(best.r)}</span>` : ''}</div>
      <div class="panel-b">${bigChart(s.hist)}</div>
    </section>
    <section class="panel">
      <div class="panel-h"><h2>Head to head</h2></div>
      <div class="panel-b table-wrap">${h2h.length ? `<table><thead><tr><th>Opponent</th><th>W-L</th><th class="r">Crowns</th><th class="r">Rating won</th></tr></thead><tbody>${h2h.map(([oid, h]) => {
        const o = data.players[oid];
        return `<tr><td><a class="pl" href="#p-${esc(oid)}">${avatar(o)}<span class="nm">${esc(o.name)}</span></a></td><td class="num">${h.w}-${h.l}${h.d ? '-' + h.d : ''}</td><td class="num r">${h.cf}–${h.ca}</td><td class="num r ${dCls(h.net)}">${fmtD(h.net)}</td></tr>`;
      }).join('')}</tbody></table>` : '<p class="muted" style="margin:0">No battles yet.</p>'}</div>
    </section>
  </div>
  <section class="panel">
    <div class="panel-h"><h2>Recent battles</h2><span class="muted" style="font-size:13px">${mine.length} total</span></div>
    <div class="panel-b">${mine.length ? `<div class="mlist">${mine.slice(-12).reverse().map(m => matchRow(m, data, C)).join('')}</div>` : '<p class="muted" style="margin:0">Nothing logged yet.</p>'}</div>
  </section>`;
}

/* ---------- routing + render ---------- */
function route() {
  let h = location.hash.slice(1);
  try { h = decodeURIComponent(h); } catch { /* keep raw */ }
  if (h.startsWith('p-')) return { v: 'player', id: h.slice(2) };
  if (h === 'matches' || h === 'rivalries') return { v: h };
  return { v: 'standings' };
}
function renderSync() {
  const pill = $('#syncPill'), txt = $('#syncText');
  const s = S.sync;
  if (S.demo || !s) { pill.hidden = true; return; }
  pill.hidden = false;
  pill.classList.remove('ok', 'err', 'busy');
  if (!s.enabled) { txt.textContent = 'Auto-sync off'; pill.title = s.lastError || ''; return; }
  if (s.running) { pill.classList.add('busy'); txt.textContent = 'Syncing…'; pill.title = ''; return; }
  if (s.lastError) { pill.classList.add('err'); txt.textContent = `Sync issue · ${ago(s.lastRunAt)}`; pill.title = s.lastError; return; }
  pill.classList.add('ok');
  txt.textContent = s.lastRunAt ? `Synced ${ago(s.lastRunAt)}` : 'Auto-sync on';
  pill.title = `Checks battle logs every ${s.intervalMinutes} min.${writable() ? ' Click to sync now.' : ''}`;
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
function render() {
  const data = D();
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
  document.querySelectorAll('nav.tabs a').forEach(a => {
    if (a.dataset.tab === r.v || (r.v === 'player' && a.dataset.tab === 'standings')) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (!S.loaded && !S.demo) {
    $('#view').innerHTML = S.error ? `<div class="loading">${esc(S.error)}</div>` : '<div class="loading">Loading the league…</div>';
    return;
  }
  const C = compute(data);
  $('#view').innerHTML = r.v === 'matches' ? viewMatches(data, C) : r.v === 'rivalries' ? viewRivalries(data, C) : r.v === 'player' ? viewPlayer(r.id, data, C) : viewStandings(data, C);
}
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

/* ---------- dialogs ---------- */
const dlg = $('#dlg');
function openDlg(title, body, foot, onMount) {
  dlg.innerHTML = `<form method="dialog" id="dform" novalidate>
    <div class="dlg-h"><h3>${title}</h3><button class="iconbtn" type="button" data-act="close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4L12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z"/></svg></button></div>
    <div class="dlg-b">${body}</div>
    <div class="dlg-f">${foot}</div></form>`;
  if (!dlg.open) dlg.showModal();
  onMount && onMount(dlg.querySelector('#dform'));
}
const closeDlg = () => { if (dlg.open) dlg.close(); };
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
    <label class="check" for="mRanked"><input id="mRanked" type="checkbox"${!m || m.ranked ? ' checked' : ''}> Counts toward ratings</label>
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
        if (!st.a || !st.b || st.a === st.b) { prev.innerHTML = 'Pick two different players to see the rating change.'; return; }
        const nm = build();
        if (!nm.ranked) { prev.innerHTML = 'This match is recorded but won’t change anyone’s rating.'; return; }
        const dl = compute({ players: D().players, matches: { ...D().matches, [nm.id]: nm } }).delta[nm.id];
        const A = D().players[st.a], B = D().players[st.b];
        prev.innerHTML = `Rating change: <b>${esc(A.name)}</b> <span class="${dCls(dl.a)}">${fmtD(dl.a)}</span> (from ${R(dl.preA)}) · <b>${esc(B.name)}</b> <span class="${dCls(dl.b)}">${fmtD(dl.b)}</span> (from ${R(dl.preB)})`;
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
  const names = [['Ava', '#Q8RL2YJ', 'Hog 2.6 Cycle'], ['Ben', '#2PYQ8LV0', 'Golem Beatdown, Night Witch, Lumberjack'], ['Chloe', '#9VUG0P', 'X-Bow 3.0'], ['Dev', '', 'Log Bait'], ['Eli', '#LJC22Q', 'Royal Giant, Fisherman, Hunter'], ['Fern', '#8CUY02', 'Lava Loon']];
  const skill = [1180, 1110, 1050, 1000, 960, 900];
  const now = Date.now(), dayMs = 864e5;
  const players = {}, ids = [];
  names.forEach((n, i) => { const id = 'demo' + i; ids.push(id); players[id] = { id, name: n[0], tag: n[1], deck: n[2], color: COLORS[i], archived: false, createdAt: now - 50 * dayMs }; });
  const matches = {};
  for (let k = 0; k < 64; k++) {
    let i = Math.floor(rnd() * 6), j = Math.floor(rnd() * 5); if (j >= i) j++;
    const pa = 1 / (1 + Math.pow(10, (skill[j] - skill[i]) / 400));
    const t = now - (44 - k * 0.68) * dayMs + Math.floor(rnd() * 5) * 36e5;
    let ca, cb, winner;
    if (rnd() < 0.07) { ca = cb = Math.floor(rnd() * 2); winner = rnd() < 0.5 ? 'draw' : (rnd() < pa ? 'a' : 'b'); }
    else {
      const aWins = rnd() < pa; const wc = rnd() < 0.45 ? 1 : rnd() < 0.55 ? 2 : 3; const lc = Math.floor(rnd() * wc);
      ca = aWins ? wc : lc; cb = aWins ? lc : wc; winner = aWins ? 'a' : 'b';
    }
    const id = 'dm' + k;
    const auto = !!(players[ids[i]].tag && players[ids[j]].tag) && rnd() < 0.8;
    matches[id] = { id, a: ids[i], b: ids[j], ca, cb, winner, playedAt: t, createdAt: t, ranked: true, mode: rnd() < 0.7 ? 'Classic' : MODES[1 + Math.floor(rnd() * 3)], notes: '', source: auto ? 'api' : 'manual' };
  }
  return { players, matches, league: { name: 'Sample League' } };
}

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const row = e.target.closest('tr[data-href]');
  if (row && !e.target.closest('a,button')) { location.hash = row.dataset.href; return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id, data = D();
  if (act === 'close') { closeDlg(); return; }
  if (act === 'demo-on') { S.demo = makeDemo(); location.hash = '#standings'; render(); return; }
  if (act === 'demo-off') { S.demo = null; render(); return; }
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
document.addEventListener('change', e => { if (e.target.id === 'filterSel') { S.filter = e.target.value; render(); } });

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
