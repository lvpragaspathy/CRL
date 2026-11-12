# CR Friends League

A Clash Royale friendly-battle league for you and your friends: Glicko-2 ratings, monthly seasons with champions, win probabilities, decks and card stats, and **automatic match tracking** from the official Clash Royale API.

Every few minutes the server pulls each tagged player's battle log, keeps the 1v1 friendlies between two league members, and adds them to the league. You can still log, edit or delete matches by hand.

```
public/          the UI (plain HTML + ES modules, no build step)
  rating.js      Glicko-2 + seasons + card stats (shared by the UI and the tests)
src/
  server.js      HTTP server + REST API + static files
  poller.js      battle log polling, dedupe, merge with manual entries
  battles.js     pure parsing of battle log entries
  store-pg.js    Postgres storage (tables created on boot)
  store-memory.js  in-memory storage for local dev/tests
test/            node:test unit + end-to-end tests with a fake CR API
```

## How auto-tracking works

- The server polls `GET /players/{tag}/battlelog` for every non-retired player who has a tag, every `POLL_MINUTES` (default 10).
- The battle log only holds the **last 25 battles**, so polling has to keep up. Because each friendly shows up in *both* players' logs, a battle is only missed if both players play 25+ other games before the next poll.
- A battle counts if its `type` is in `FRIENDLY_TYPES` (default `friendly,clanMate`), it's 1v1, and both tags belong to league players.
- The same battle seen from both sides gets one ID (`battleTime|tagA|tagB`), so it's only stored once.
- If someone already logged the match by hand (same two players, within `LINK_WINDOW_MINUTES` of the real battle time), the import **merges** into that entry instead of duplicating it. The API's crowns and time win; your notes and rated/unrated choice stay.
- Deleting an imported match keeps a hidden record of it, so it doesn't get imported again on the next poll.
- **Tiebreakers:** when crowns are level, the server compares each side's lowest remaining tower HP from the battle log (the in-game tiebreaker rule). Turn this off with `INFER_TIEBREAK=false` if it gets real tiebreakers wrong; level crowns then count as draws.

> Check after your first real session: confirm in the logs or the UI that your friendlies come through with the expected `type`. If they use a different value, add it to `FRIENDLY_TYPES`.

## Deploy on Railway

1. **Get an API key.** Sign in at <https://developer.clashroyale.com> → My Account → Create New Key. For allowed IP addresses, enter **`45.79.218.79`**. That's the RoyaleAPI proxy, which this app uses by default because Railway's outbound IP isn't fixed on most plans.
2. **Push this folder to a GitHub repo.**
3. In Railway: **New Project → Deploy from GitHub repo** → pick the repo. Railway detects Node and runs `npm start`.
4. In the same project: **+ New → Database → PostgreSQL**.
5. Open the web service → **Variables** and add:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference variable; uses Railway's private network, no SSL needed) |
   | `CR_API_TOKEN` | the key from step 1 |
   | `LEAGUE_PASSWORD` | a password you share with friends who should be able to edit |
   | `POLL_MINUTES` | optional, default `10` |

6. **Settings → Networking → Generate Domain** to get a public URL. Optionally set the health check path to `/healthz`.
7. Open the URL, click **Unlock editing**, add everyone with their player tag, and play a friendly. The sync pill in the nav shows the last poll; editors can click it to sync right away.

Keep the service at **one replica** with app sleeping **off**. The poller runs inside the web process, so a sleeping service stops polling, and two replicas would both poll the API.

Already have data in the Claude-hosted version? Click **Copy data as JSON** there, then **Import JSON** here. It merges by ID, so running it twice is safe.

## All settings

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Railway sets this. |
| `DATABASE_URL` | none | Without it, data lives in memory and is lost on restart. |
| `PGSSL` | `false` | Set `true` if you connect over Railway's *public* Postgres URL. |
| `CR_API_TOKEN` | none | Without it, auto-tracking is off and the UI says so. |
| `CR_API_BASE` | `https://proxy.royaleapi.dev/v1` | Use `https://api.clashroyale.com/v1` if your host has a static IP that you whitelisted. |
| `POLL_MINUTES` | `10` | Minimum 2. |
| `FRIENDLY_TYPES` | `friendly,clanMate` | Battle log `type` values that count. |
| `INFER_TIEBREAK` | `true` | Decide level-crown battles by tower HP. |
| `LINK_WINDOW_MINUTES` | `15` | How close a manual entry has to be to merge with an import. |
| `LEAGUE_PASSWORD` | none | Required for any edits. Viewing is always public. |
| `LEAGUE_TIMEZONE` | `America/Chicago` | Seasons roll over at midnight on the 1st in this IANA time zone. |

## Run locally

```bash
npm install
cp .env.example .env   # fill in CR_API_TOKEN and LEAGUE_PASSWORD
npm run dev            # http://localhost:3000, in-memory store unless DATABASE_URL is set
npm test               # 15 tests, including a full sync against a fake CR API
```

Local dev through the proxy works from any network, since the key is whitelisted for the proxy's IP rather than yours.

## API

Reads are public. Writes need the `X-League-Password` header.

| Method | Path | |
|---|---|---|
| GET | `/api/league` | players, matches, league name, sync status |
| GET | `/api/auth` | 200 if the password header is right |
| PATCH | `/api/league` | `{ name }` |
| POST / PATCH / DELETE | `/api/players[/:id]` | delete only works for players with no matches (retire them instead) |
| POST / PATCH / DELETE | `/api/matches[/:id]` | `{ a, b, ca, cb, winner?, playedAt, mode, notes, ranked }` |
| POST | `/api/sync` | poll now |
| POST | `/api/import` | merge a JSON export |

## Ratings

Ratings are never stored. The UI replays every match in time order (`public/rating.js`).

**Glicko-2** (Glickman 2012). Each player has a rating *r* (starts 1500), a rating deviation *RD* (starts 350: how unsure the rating is) and a volatility *σ*. Every game is its own rating period, and each idle day adds a period's worth of uncertainty before the next game, so RD grows while someone is away. The implementation is checked against the worked example in Glickman's paper (`test/rating.test.js`).

**Crown margin.** Plain Glicko-2 only sees win/draw/loss, so the rating move (μ' − μ) is multiplied by `1 + bonus × 2(1 − p)`, where bonus is 0 / 0.15 / 0.30 for a 1/2/3-crown margin and p is the winner's pre-game win chance. Even game: ×1.00 / ×1.15 / ×1.30. The surprise weighting stops favorites from snowballing by stomping weaker players (the same autocorrelation problem FiveThirtyEight's Elo corrects for). RD and volatility are untouched, so a big margin moves ratings further without making the system more certain. Tiebreaker wins and draws use ×1.

**Win probability** for A vs B: `1 / (1 + exp(-g(√(φA² + φB²)) · (μA − μB)))`, where `g(φ) = 1/√(1 + 3φ²/π²)`. Two uncertain ratings pull the odds toward 50%. A win the model gave under 35% is marked as an upset.

**Seasons** are calendar months in `LEAGUE_TIMEZONE`. At each rollover every rating moves halfway back to 1500 and RD is raised to at least 150, so the first few games of a month are placements. The champion is the highest rating at month's end with 5+ battles. The "All time" view runs the same model with no resets.

**Decks** come from the battle log for auto-imported matches, stored compactly on each match (`{cards: [{id, evo}], tower}`) with names, elixir and icons in a separate `cards` table. Battles imported before deck tracking existed get their decks filled in while they're still in someone's last 25 battles.
