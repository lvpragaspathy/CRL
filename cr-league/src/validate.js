import { normTag, isValidTag } from './battles.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = msg => { throw new HttpError(400, msg); };

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const isId = s => typeof s === 'string' && ID_RE.test(s);
export const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Validate player fields. With partial=true only the fields present are checked/returned. */
export function playerInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object') bad('Send the player as a JSON object.');
  const out = {};
  if (!partial || 'name' in body) {
    const name = str(body.name, 32);
    if (!name) bad('Give the player a name.');
    out.name = name;
  }
  if (!partial || 'tag' in body) {
    const tag = normTag(body.tag || '');
    if (tag && !isValidTag(tag)) bad('Player tags are a # followed by 3 to 14 of these characters: 0 2 8 9 C G J L P Q R U V Y.');
    out.tag = tag;
  }
  if (!partial || 'color' in body) out.color = COLOR_RE.test(body.color) ? body.color : '#4a90ff';
  if (!partial || 'deck' in body) out.deck = str(body.deck, 160);
  if (!partial || 'archived' in body) out.archived = body.archived === true;
  return out;
}

/** Validate match fields. Winner is derived from crowns unless crowns are level. */
export function matchInput(body, { partial = false, existing = null } = {}) {
  if (!body || typeof body !== 'object') bad('Send the match as a JSON object.');
  const m = { ...(existing || {}) };
  for (const k of ['a', 'b']) if (!partial || k in body) {
    if (!isId(body[k])) bad('Choose a player for both sides.');
    m[k] = body[k];
  }
  for (const k of ['ca', 'cb']) if (!partial || k in body) {
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < 0 || n > 3) bad('Crowns must be a whole number from 0 to 3.');
    m[k] = n;
  }
  if (!partial || 'playedAt' in body) {
    const t = Number(body.playedAt);
    if (!Number.isFinite(t) || t < Date.UTC(2016, 0, 1) || t > Date.now() + 864e5) bad('Add a valid date and time for when the match was played.');
    m.playedAt = Math.round(t);
  }
  if (!partial || 'mode' in body) m.mode = str(body.mode, 40) || 'Classic';
  if (!partial || 'notes' in body) m.notes = str(body.notes, 200);
  if (!partial || 'ranked' in body) m.ranked = body.ranked !== false;
  if (!partial || 'winner' in body || 'ca' in body || 'cb' in body) {
    const w = body.winner ?? m.winner;
    m.winner = m.ca !== m.cb ? (m.ca > m.cb ? 'a' : 'b') : (['a', 'b', 'draw'].includes(w) ? w : 'draw');
  }
  if (m.a === m.b) bad("A player can't battle themselves. Pick two different players.");
  return m;
}
