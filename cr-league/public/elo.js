// Rating engine. Ratings are never stored: they're rebuilt by replaying every match in order,
// so editing or deleting an old match fixes everything after it.
export const START = 1000;   // everyone's starting rating
export const K_NEW = 40;     // K-factor during placement games
export const K = 24;         // K-factor after placement
export const PROV = 10;      // number of placement (rated) games

/** Expected score for a player rated `ra` against `rb` (logistic curve, 400-point scale). */
export const expected = (ra, rb) => 1 / (1 + Math.pow(10, (rb - ra) / 400));

/** Margin-of-victory multiplier from the crown difference. */
export function marginMult(m) {
  if (m.winner === 'draw') return 1;
  const diff = Math.abs(m.ca - m.cb);
  return diff >= 3 ? 1.3 : diff === 2 ? 1.15 : 1;
}

export const byTime = (x, y) => x.playedAt - y.playedAt || x.createdAt - y.createdAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

export function compute(data) {
  const P = data.players, st = {};
  for (const id in P) st[id] = {
    id, rating: START, ranked: 0, games: 0, w: 0, l: 0, d: 0, cf: 0, ca: 0, three: 0, peak: START,
    hist: [START], streakT: '', streakN: 0, best: 0, form: [], last: null, h2h: {},
  };
  const ms = Object.values(data.matches).filter(m => st[m.a] && st[m.b] && m.a !== m.b).sort(byTime);
  const delta = {};
  for (const m of ms) {
    const A = st[m.a], B = st[m.b];
    const preA = A.rating, preB = B.rating;
    let dA = 0, dB = 0;
    if (m.ranked) {
      const ea = expected(preA, preB);
      const sa = m.winner === 'a' ? 1 : m.winner === 'b' ? 0 : 0.5;
      const mult = marginMult(m);
      const ka = A.ranked < PROV ? K_NEW : K, kb = B.ranked < PROV ? K_NEW : K;
      dA = ka * mult * (sa - ea);
      dB = kb * mult * ((1 - sa) - (1 - ea));
      A.rating += dA; B.rating += dB; A.ranked++; B.ranked++;
      A.peak = Math.max(A.peak, A.rating); B.peak = Math.max(B.peak, B.rating);
      A.hist.push(A.rating); B.hist.push(B.rating);
      A.last = dA; B.last = dB;
    }
    tally(A, m.ca, m.cb, m.winner === 'a' ? 'W' : m.winner === 'b' ? 'L' : 'D', m.b, dA);
    tally(B, m.cb, m.ca, m.winner === 'b' ? 'W' : m.winner === 'a' ? 'L' : 'D', m.a, dB);
    delta[m.id] = { a: m.ranked ? dA : null, b: m.ranked ? dB : null, preA, preB };
  }
  return { st, ms, delta };
}

function tally(s, cf, ca, r, opp, d) {
  s.games++; s.cf += cf; s.ca += ca;
  if (r === 'W') { s.w++; if (cf === 3) s.three++; } else if (r === 'L') s.l++; else s.d++;
  if (r === 'D') { s.streakT = ''; s.streakN = 0; }
  else if (s.streakT === r) s.streakN++;
  else { s.streakT = r; s.streakN = 1; }
  if (s.streakT === 'W') s.best = Math.max(s.best, s.streakN);
  s.form.push(r); if (s.form.length > 5) s.form.shift();
  const h = s.h2h[opp] || (s.h2h[opp] = { n: 0, w: 0, l: 0, d: 0, cf: 0, ca: 0, net: 0 });
  h.n++; h[r === 'W' ? 'w' : r === 'L' ? 'l' : 'd']++; h.cf += cf; h.ca += ca; h.net += d;
}

export function tier(s) {
  if (s.ranked < PROV) return { name: s.ranked ? `Placement ${s.ranked}/${PROV}` : 'Unranked', cls: 't-place' };
  const r = s.rating;
  if (r >= 1250) return { name: 'Champion', cls: 't-champ' };
  if (r >= 1150) return { name: 'Diamond', cls: 't-diamond' };
  if (r >= 1050) return { name: 'Gold', cls: 't-gold' };
  if (r >= 950) return { name: 'Silver', cls: 't-silver' };
  return { name: 'Bronze', cls: 't-bronze' };
}

export function ranking(data, C) {
  return Object.values(data.players).filter(p => !p.archived).sort((x, y) => {
    const a = C.st[x.id], b = C.st[y.id];
    return (b.games > 0) - (a.games > 0) || b.rating - a.rating || b.games - a.games || x.name.localeCompare(y.name);
  });
}

export const pct = s => (s.games ? Math.round(100 * (s.w + 0.5 * s.d) / s.games) + '%' : '—');
