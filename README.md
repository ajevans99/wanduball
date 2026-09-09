# Wanduball

A ten-manager fantasy-football chaos room built with Next.js 16, React, and Supabase. Review player pools, make random assignments, spin league-wide scoring changes, and keep an application/cleanup ledger.

## Spinning the player wheel

In **Weekly setup**, review and lock the top ten for each position you want to assign. Open **The chaos room** and click **Assign a QB** (or the selected position). The randomly selected manager is announced with a three-second countdown, then the player wheel spins for five seconds. The manager stays visible throughout, and the assignment appears in the on-screen ledger after the wheel stops. Both choices are saved together once, so refreshing or reconnecting does not reroll them.

Finish all ten assignments for every locked position before flipping the duration coin, choosing the scoring rule, and spinning the points wheel.

### Auto-mode

Switch on **Auto-mode** in **The chaos room** to run the next eligible wheel after a three-second countdown. It finishes all locked player pools in QB/RB/WR/TE order, then runs the duration coin, rule wheel, and points wheel. Each result gets a three-second breather after its animation finishes; player assignments still include their manager announcement and countdown.

Auto-mode starts off and belongs only to the operating browser tab. Only the commissioner can enable it in shared rooms; every spin uses the same authorized, version-checked command path as a manual click, with results synchronized to spectators. Switching it off cancels the next queued spin without undoing a result already committed. Leaving the chaos room, opening a dialog, reloading, losing editing permission, or encountering an error switches it off. After an error, resolve it and explicitly enable auto-mode again; failed or uncertain commands are never automatically retried.

Auto-mode stops when this week's scoring spin is complete. It never locks pools, imports players, advances the week, confirms cleanup, or changes anything in Sleeper.

### Player nicknames

In **Weekly setup**, enter a nickname beneath any NFL player's name and click **Save** (or press Enter). Nicknames are optional, trimmed, and limited to 40 characters. Click **Clear**, or save an empty/whitespace-only value, to remove one. This never changes the player's imported real name, ranking, eligibility, or Sleeper roster.

Nicknames appear on player wheels, results, and assignment displays alongside the real name so roster moves remain unambiguous. They are saved by stable Sleeper player ID, survive repeat imports (even if a player temporarily disappears), and carry forward when next week's pool is reset. Practice saves them in this browser; shared rooms save them through the existing commissioner-only, version-checked command path and synchronize to spectators. Nicknames are public shared-room data—do not enter private information.

Naming edits are allowed after a pool is locked, but are blocked throughout any active countdown or spin. Each assignment and wheel result snapshots the nickname used at spin time; later edits or clearing affect future spins, not past results or the historical ledger. Older saved games without nicknames continue to work.

## Appearance

Use the header's **Light / Dark / System** selector to choose an appearance. **System** is the default and follows your operating system. Your choice is saved locally and synchronizes across same-origin browser tabs without changing league data. It is not a shared room setting; spectators choose their own appearance.

## Practice versus shared rooms

- **Local practice:** available without Supabase. Uses fictional sample rankings, browser-local state, and local randomness. It is not a live Sleeper feed, shared storage, or an authoritative commissioner session. Different browsers do not synchronize practice state.
- **Shared rooms:** require all three environment variables, the database migration, and a signed-in Supabase user to create a room. Rooms start with **no players or assignments**, awaiting an explicit Sleeper import. The starter manager list and scoring rules are defaults; import replaces managers and supplies actual league scoring baselines.
- The owner is the user who created the room. Spectators need no account. Commands are authenticated on the server, checked against immutable room ownership, and use Node's cryptographic random generator. Every accepted command increments the database version. Concurrent/stale commands receive HTTP 409 instead of overwriting another result.
- This tool does **not** modify Sleeper rosters or scoring settings. The commissioner must make those changes in Sleeper and check off their application, player drops, and weekly scoring restoration here. Keep an exported ledger before deleting rooms or starting another season.

### Important: shared game data is PUBLIC

**A room UUID is a convenient sharing/discovery link, not a confidentiality boundary.** Supabase SELECT and Realtime policies deliberately permit anonymous reads of **all** rooms, including enumeration through the Supabase API. The game state (manager names, players, league ID, rules, and ledger), room ID, owner UUID, version, and timestamps can be publicly read. The REST room endpoint itself only returns game state and version.

Do not enter emails, passwords, tokens, private notes, or other sensitive information into manager names, custom rules, or any game state. Authentication emails and tokens are not automatically copied into rooms or returned by the room API. Account identity is managed separately by Supabase Auth. There are no anonymous/authenticated direct database write grants or write policies. The service-role key must remain server-only.

If confidential leagues are required, replace this public model with authenticated membership policies and appropriately authorized Realtime subscriptions **before** using it; hiding a UUID is not sufficient.

## Local setup

Use Node.js 22. Install dependencies and start the app:

```sh
npm install
cp .env.example .env.local
npm run dev
```

Open http://localhost:3001. Leave Supabase variables unset to use practice only; shared-room calls return a helpful HTTP 503 until configured. Sleeper import is a server-side, read-only public API and needs no Sleeper credentials.

### Supabase setup

1. Create a Supabase project.
2. Open **SQL Editor**, paste the complete contents of `supabase/migrations/202609090001_create_rooms.sql`, and run it **once**. It creates `public.rooms`, the immutable-owner/version trigger, read-only client permissions, public SELECT policy, and Realtime publication membership in one transaction. It is an initial migration, not a destructive reset; do not rerun it over an existing table. Alternatively, use your installed Supabase CLI's `supabase link --project-ref YOUR_PROJECT_REF` followed by `supabase db push` to track/apply the migration.
3. Confirm `public.rooms` is enabled under the `supabase_realtime` publication in the database publications/Realtime settings. The migration enables it. Ordinary UPDATE payloads contain the new state/version; full old-row replication is not required.
4. In **Authentication → Providers**, enable email/password authentication. In **Authentication → Users → Add user**, create the commissioner's email/password user with **Auto Confirm User** selected. This dashboard-created confirmed account can sign in directly; no custom SMTP or email delivery is needed. Do not share the password with spectators. You can disable public sign-ups if only your designated commissioners should create rooms.
5. Copy Project Settings → API values into `.env.local`:
   - `NEXT_PUBLIC_SUPABASE_URL`: project URL.
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`: public/legacy anon API key.
   - `SUPABASE_SERVICE_ROLE_KEY`: secret legacy service-role API key, **server only**.
6. Restart `npm run dev`, sign in, create a shared room, and share its room URL. A local server URL is accessible only where that server is reachable; use deployment below for remote spectators.

The service-role key bypasses RLS. Only the server uses it, after `auth.getUser(accessToken)` verifies the caller and the room owner is checked. Do not expose it in browser code or use it as a spectator key. Deleting the owner's Supabase Auth account cascades deletion of that user's rooms; export records first.

## Sleeper import and ranking semantics

Import requires a numeric **NFL league ID for the selected season**, exactly 10 owned rosters with distinct owners, a game season, and a game week (1–18). Names come from roster owners' team names/display names. No email fields are imported.

- Ranking defaults to **PPR**. `half_ppr` and `std` are also supported.
- For `statsSeason=season` (the default), rankings are **cumulative fantasy points from completed regular-season weeks strictly before the selected game week**, not projections, the selected week's live scores, or end-of-season totals. Future/unfinished periods are rejected using Sleeper's current NFL state.
- Week 1 has no prior completed weeks. Explicitly set `statsSeason` to an earlier season (for example, game season 2026/week 1 with `statsSeason=2025`) to use that season's full regular-season totals. The response's `season` and `week` remain the **game setup** values; the `source` label explicitly identifies the different statistics season. There is no automatic previous-season fallback.
- Rankings use Sleeper's `pts_ppr`, `pts_half_ppr`, or `pts_std` fields. They do not approximate custom league-scoring rankings. `ranking=league` returns a helpful HTTP 400 because nonlinear bonuses/custom formulas are not implemented.
- The response includes the league's finite `scoring_settings` as `baselines` for the scoring ledger, independently of the chosen ranking format.
- Up to 30 positive-scoring players per QB/RB/WR/TE are returned so manually excluded players can be replaced in the top ten. Injured players are **not** automatically removed. Review injury labels and eligibility before locking pools. Player names, positions, teams, and injuries come from the current dictionary, not a historical roster snapshot.
- The NFL player dictionary is requested with daily revalidation and retained in a bounded, per-process daily cache (the raw payload can exceed Next's cache-entry limit); league data is cached for five minutes and statistics for one hour. Cold starts may refetch. Historical corrections can change a later import, but once imported the room stores its own ranking snapshot.
- Public read endpoints use `https://api.sleeper.app/v1/league/...`, `/players/nfl`, `/state/nfl`, and `/stats/nfl/regular/{season}[/{week}]`. **The statistics endpoints are undocumented and have no guaranteed schema or availability.** Provider errors, missing/invalid statistics, and insufficient eligible players produce explicit errors—never demo data or synthetic scores. Re-import after an upstream recovery.

## API contract

All responses are JSON and carry `Cache-Control: no-store`. Errors use `{ "error": "human-readable explanation" }`. Individual upstream Sleeper requests are cached as described above.

### Rooms

`GET /api/room?room=<uuid>` → `{ state: GameState, version: number }`.

`POST /api/room` requires `Authorization: Bearer <Supabase Auth access token>` and a JSON body:

```json
{ "type": "create" }
```

Returns HTTP 201: `{ roomId, state, version: 0 }`.

```json
{
  "type": "command",
  "roomId": "your-room-uuid",
  "version": 0,
  "command": { "type": "lock", "position": "QB" }
}
```

Returns `{ state, version }`. Commands use `commandSchema` in `src/lib/game.ts`; arbitrary client-supplied room state is not accepted. Import is an owner-controlled command, so a commissioner can intentionally choose imported content; this is not an independently audited Sleeper-proof system. Neither the client nor a spectator can submit a spin result.

To set or clear a player's nickname, use `{"type":"nickname","playerId":"<Sleeper player ID>","nickname":"The Buffalo"}` (use `""` to clear). The player must be in the currently imported list. `GameState.nicknames` is an optional ID-to-nickname map; assignment entries have an optional `nickname` snapshot. Both fields are absent in older saves and require no database migration.

Status codes: 400 invalid input, 401 invalid/missing session, 403 wrong owner, 404 missing room, 409 stale/racing version, 413 body over 256 KB, 422 invalid game transition, 503 unconfigured/unavailable storage or auth. On 409, refetch state and ask the user to retry; do not automatically reroll. If a network error occurs after submitting a command, refetch first because the write may already have succeeded.

For live updates, subscribe using the public browser Supabase client:

```ts
supabase.channel(`room:${roomId}`)
  .on("postgres_changes", {
    event: "UPDATE",
    schema: "public",
    table: "rooms",
    filter: `id=eq.${roomId}`,
  }, () => { /* refetch GET /api/room?room=... */ })
  .subscribe()
```

Subscribe before an initial/refreshed read to reduce missed-update races; refresh after reconnect and retain polling as a fallback. Only accept incoming versions newer than the displayed version. The filter is a subscription convenience, **not** a privacy rule.

### Sleeper

`GET /api/sleeper?leagueId=<digits>&season=2026&week=2&statsSeason=2026&ranking=ppr`

Returns `{ players: Player[], managers: {id,name}[], season, week, leagueId, source, baselines }`. `statsSeason` is optional and defaults to `season`. Use the returned fields in an `import` command after review. HTTP 400 means invalid/unsupported input, 404 missing provider resource, 422 unavailable/ineligible ranking data or league setup, 502 provider failure/schema mismatch, and 503 rate limiting/service failure.

## Deploy on Vercel

1. Push the project to your own repository and import it into Vercel as a Next.js project.
2. Set all three Supabase environment variables for the intended deployment environments. `NEXT_PUBLIC_*` values are bundled at build time, so redeploy after changing them.
3. Apply the Supabase migration if not already applied. Create the confirmed commissioner account as above.
4. Deploy and use the generated `*.vercel.app` HTTPS URL. **No purchased domain is necessary.** Create a shared room on the deployed app and share that deployed URL.
5. Test from a second browser: it should read live results without signing in, and all writes should require the owning commissioner's account.

Use separate Supabase projects for production and untrusted previews if needed. Protect deployments with Vercel's request/rate controls before broader public use: this starter does not implement per-user room quotas or distributed API rate limiting. Do not rely on an in-memory rate limiter for serverless protection.

## Validation

```sh
npm test
node --test tests/server.test.mjs
npm run lint
npm run build
```

Browser tests are available with `npm run test:e2e` using the existing Playwright configuration. On a fresh machine, run `npx playwright install chromium` once to download the browser. A live Supabase smoke test additionally requires real project credentials: create a room, fetch anonymously, verify a second user receives 403, send two commands with the same version and verify one receives 409, confirm direct anon/authenticated database writes fail, and check spectator Realtime updates.
