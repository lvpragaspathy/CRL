// All settings come from environment variables so Railway can set them in the dashboard.
const bool = (v, dflt) => (v == null || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v));

export const config = {
  port: Number(process.env.PORT) || 3000,

  // Postgres. Without it the server runs on an in-memory store (fine for local dev, wiped on restart).
  databaseUrl: process.env.DATABASE_URL || '',
  // Railway's private network URL (*.railway.internal) needs no SSL; the public proxy URL does.
  pgSsl: bool(process.env.PGSSL, false),

  // Clash Royale API. Railway has no fixed outbound IP on most plans, so the RoyaleAPI proxy is the default.
  // Whitelist 45.79.218.79 on your key at developer.clashroyale.com when using the proxy.
  crToken: process.env.CR_API_TOKEN || '',
  crBase: (process.env.CR_API_BASE || 'https://proxy.royaleapi.dev/v1').replace(/\/+$/, ''),
  pollMinutes: Math.max(2, Number(process.env.POLL_MINUTES) || 10),
  // Battle log "type" values that count as league friendlies.
  friendlyTypes: (process.env.FRIENDLY_TYPES || 'friendly,clanMate')
    .split(',').map(s => s.trim()).filter(Boolean),
  // When crowns are level, decide the winner from remaining tower HP (the in-game tiebreaker rule).
  inferTiebreak: bool(process.env.INFER_TIEBREAK, true),
  // A manually logged match within this window of an imported battle (same two players) gets merged.
  linkWindowMinutes: Math.max(1, Number(process.env.LINK_WINDOW_MINUTES) || 15),

  // Shared password for anything that changes data. Viewing is always public.
  password: process.env.LEAGUE_PASSWORD || '',
};
