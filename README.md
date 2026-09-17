# Wanduball

A ten-manager fantasy-football chaos room built with Next.js 16, React, and Supabase. Review player pools, make random assignments, spin league-wide scoring changes, and keep an application/cleanup ledger.

## Spinning the player wheel

In **Weekly setup**, review and lock the top ten for each position you want to assign. Open **The chaos room** and click **Assign a QB** (or the selected position). The randomly selected manager is announced with a three-second countdown, then the player wheel spins for five seconds. The manager stays visible throughout, and the assignment appears in the on-screen ledger after the wheel stops. Both choices are saved together once, so refreshing or reconnecting does not reroll them.

Finish all ten assignments for every locked position before flipping the duration coin, choosing the scoring rule, and spinning the points wheel.

### Auto-mode

Tight ends are temporarily disabled via `enabledPositions` in `src/lib/game.ts`. TE tabs remain visible but disabled; imports and existing TE history are preserved. New TE locks/assignments are blocked, auto-mode skips TE, and unfinished old TE pools do not block Round 2. TE is explicitly excluded from automatic outgoing-week Sleeper cleanup. Add TE back to `enabledPositions` to restore wheel eligibility; cleanup eligibility remains separately restricted to QB/RB/WR.

Each position takes nine spins: the last remaining player goes to the last manager automatically, revealed alongside pick nine. Points-wheel slices are shuffled for each spin and saved in that order for everyone watching; the odds are unchanged. The rulebook's points list stays numerically sorted.

Switch on **Auto-mode** in **The chaos room** to finish Round 1's locked player pools in QB/RB/WR/TE order, with three seconds between results. Player assignments keep their manager announcement and countdown. Round 2's duration coin, rule wheel, and points wheel are always manual, including when resuming a partially completed scoring round.

Auto-mode starts off and belongs only to the operating browser tab. Any room commissioner can enable it in shared rooms; every spin uses the same authorized, version-checked command path as a manual click, with results synchronized to spectators. Use one operating tab for auto-mode at a time; competing commands receive a conflict instead of overwriting results. Switching it off cancels the next queued spin without undoing a result already committed. Leaving the chaos room, opening a dialog, reloading, losing editing permission, or encountering an error switches it off. After an error, resolve it and explicitly enable auto-mode again; failed or uncertain commands are never automatically retried.

Auto-mode stops after the final player assignment. It never runs Round 2, locks pools, imports players, advances the week, or confirms cleanup. In the approved live room from 2026 Week 3, the separate automatic Sleeper-add feature applies each newly committed player result after its reveal; wheel auto-mode waits for those writes.

### Player nicknames

In **Weekly setup**, enter a nickname beneath any NFL player's name and click **Save** (or press Enter). Nicknames are optional, trimmed, and limited to 40 characters. Click **Clear**, or save an empty/whitespace-only value, to remove one. This never changes the player's imported real name, ranking, eligibility, or Sleeper roster.

Player wheel slices show larger nickname-only labels (or the real name when no nickname is set). Labels longer than 21 characters are abbreviated with an ellipsis instead of shrinking the type. Hover text and accessible labels retain both names; results and assignment displays retain the real name so roster moves remain unambiguous. Slice labels are snapshotted with each spin, just like the full result. Nicknames are saved by stable Sleeper player ID, survive repeat imports (even if a player temporarily disappears), and carry forward when next week's pool is reset. Practice saves them in this browser; shared rooms save them through the existing commissioner-only, version-checked command path and synchronize to spectators. Nicknames are public shared-room data—do not enter private information.

Naming edits are allowed after a pool is locked, but are blocked throughout any active countdown or spin. Each assignment and wheel result snapshots the nickname used at spin time; later edits or clearing affect future spins, not past results or the historical ledger. Older saved games without nicknames continue to work.

## Appearance

Use the header's **Light / Dark / System** selector to choose an appearance. **System** is the default and follows your operating system. Your choice is saved locally and synchronizes across same-origin browser tabs without changing league data. It is not a shared room setting; spectators choose their own appearance.

## Practice versus shared rooms

- **Local practice:** available without Supabase. Uses fictional sample rankings, browser-local state, and local randomness. It is not a live Sleeper feed, shared storage, or an authoritative commissioner session. Different browsers do not synchronize practice state.
- **Shared rooms:** require all three environment variables, the database migration, and a signed-in Supabase user to create a room. Rooms start with **no players or assignments**, awaiting an explicit Sleeper import. The starter manager list and scoring rules are defaults; import replaces managers and supplies actual league scoring baselines.
- The owner is the user who created the room and may add co-commissioners. Spectators need no account. Commands are authenticated on the server, checked against room ownership or commissioner membership, and use Node's cryptographic random generator. Every accepted command increments the database version. Concurrent/stale commands receive HTTP 409 instead of overwriting another result.
- The approved connected room supports verified Sleeper adds and intentional weekly roster cleanup on **Open next week** (see below). Scoring edits remain manual; weekly scoring restoration and permanent rule application are required before cleanup. Other rooms and local practice retain their existing manual behavior. Keep an exported ledger before deleting rooms or starting another season.

### Important: shared game data is PUBLIC

**A room UUID is a convenient sharing/discovery link, not a confidentiality boundary.** Supabase SELECT and Realtime policies deliberately permit anonymous reads of **all** rooms, including enumeration through the Supabase API. The game state (manager names, players, league ID, rules, and ledger), room ID, owner UUID, version, and timestamps can be publicly read. The REST room endpoint itself only returns game state and version.

Do not enter emails, passwords, tokens, private notes, or other sensitive information into manager names, custom rules, or any game state. Authentication emails and tokens are not automatically copied into rooms or returned by the public room API. Commissioner membership is stored separately in a private table; only the room creator can retrieve co-commissioner emails through the authenticated management endpoint. Account identity is managed separately by Supabase Auth. There are no anonymous/authenticated direct database write grants or write policies. The service-role key must remain server-only.

### Multiple commissioners

Sign in as the room creator, open the header's **Room settings** button (**Chaos control center**), and enter each additional commissioner's account email under **Room commissioners**. For three commissioners, the creator adds the other two accounts. Accounts must already exist in Supabase Auth and have confirmed email addresses; this action does not create accounts or send invitation emails.

Share the same room URL with all commissioners. Each signs in with their own account and can import players, edit nicknames and rules, spin all wheels, use auto-mode, maintain the ledger, and advance weeks. Only the creator sees the membership list and can add or remove co-commissioners; the creator cannot be removed or replaced through this feature. Access is specific to each room, not every room in the project.

Removing access prevents subsequent commands, including commands that were prepared before removal but have not yet been committed. Command saves and membership changes serialize against the same room lock, with version checks preventing concurrent commissioners from overwriting each other. Open tabs refresh permissions every 15 seconds, when focused, and after a rejected command. A permission-loading failure disables editing rather than assuming access. Spectators remain anonymous and read-only.

If confidential leagues are required, replace this public model with authenticated membership policies and appropriately authorized Realtime subscriptions **before** using it; hiding a UUID is not sufficient.

## Local setup

Use Node.js 22. Install dependencies and start the app:

```sh
npm install
cp .env.example .env.local
npm run dev
```

Open http://localhost:3001. Leave Supabase variables unset to use practice only; shared-room calls return a helpful HTTP 503 until configured. Sleeper import is a server-side, read-only public API and needs no Sleeper credentials.

Weekly setup prefills league ID `1389331555339468800` (Wanduball 2026, ten rosters). Import remains an explicit action; the default does not replace existing saved league data or turn practice rankings into live rankings. The supplied mascot is served locally from `public/wanduball-mascot.jpg`.

### Supabase setup

1. Create a Supabase project.
2. Install the Supabase CLI if necessary (`brew install supabase/tap/supabase`), run `supabase login`, then `supabase link --project-ref YOUR_PROJECT_REF`, review `supabase db push --dry-run`, and run `supabase db push`. Apply **all** migrations in `supabase/migrations`, including the commissioner-access migration. Existing rooms retain their original creator and game data. The initial migration creates `public.rooms`, the immutable-owner/version trigger, read-only client permissions, public SELECT policy, and Realtime publication membership. The Sleeper migration binds only the explicitly approved room if it exists; fresh projects have no live binding. Do not rerun the initial SQL over an existing table. If applying SQL manually through **SQL Editor**, run each unapplied migration exactly once in filename order; do not mix manual application with CLI migration history without reconciling it.
3. Confirm `public.rooms` is enabled under the `supabase_realtime` publication in the database publications/Realtime settings. The migration enables it. Ordinary UPDATE payloads contain the new state/version; full old-row replication is not required.
4. In **Authentication → Providers**, enable email/password authentication. In **Authentication → Users → Add user**, create the commissioner's email/password user with **Auto Confirm User** selected. This dashboard-created confirmed account can sign in directly; no custom SMTP or email delivery is needed. Do not share the password with spectators. You can disable public sign-ups if only your designated commissioners should create rooms.
5. Copy Project Settings → API values into `.env.local`:
   - `NEXT_PUBLIC_SUPABASE_URL`: project URL.
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`: publishable (`sb_publishable_...`) or legacy anon API key.
   - `SUPABASE_SERVICE_ROLE_KEY`: secret (`sb_secret_...`) or legacy service-role API key, **server only**. The variable name stays the same for either key type.
6. Restart `npm run dev`, sign in, create a shared room, and share its room URL. A local server URL is accessible only where that server is reachable; use deployment below for remote spectators.

The service-role key bypasses RLS. Only the server uses it, after `auth.getUser(accessToken)` verifies the caller and room ownership or commissioner membership is checked. Management operations require the owner, and command commits recheck permissions atomically in the database. Do not expose the key in browser code or use it as a spectator key. Deleting the owner's Supabase Auth account cascades deletion of that user's rooms; export records first. Deleting a co-commissioner's account removes their memberships without deleting the rooms.

## Sleeper import and ranking semantics

Import requires a numeric **NFL league ID for the selected season**, exactly 10 owned rosters with distinct owners, a game season, and a game week (1–18). Names come from roster owners' team names/display names. No email fields are imported.

- Ranking defaults to **league scoring** and Weekly setup requests it explicitly. The imported league's actual `scoring_settings` supply the weights; generic `ppr`, `half_ppr`, and `std` remain explicit API alternatives.
- For `statsSeason=season` (the default), **Week N uses only that season's Week N actual statistics**, including Week 1. It never sums earlier weeks, uses Week N−1, or substitutes projections. Future weeks are rejected using Sleeper's NFL state. Current-week actuals may be partial and are labeled accordingly; re-import for final results/corrections.
- Only for Week 1, explicitly choose the previous-season fallback in Weekly setup (or an earlier `statsSeason` through the API) to use full regular-season totals. Setup season/week remain unchanged; the source explicitly identifies the fallback. Week N > 1 rejects an earlier stats season. No automatic fallback occurs.
- League points multiply Sleeper's sparse **event counters** by the matching scoring weights. Provider bonus counters are authoritative: positional reception/first-down bonuses apply only to that position; yardage tiers and overlapping long-play bonuses are not inferred from totals or longest plays. IDP counters also count on offensive players (for example a QB tackle). Unknown nonzero scoring keys reject the import rather than silently approximate; explicit null scoring counters also reject. Missing event counters mean zero in the sparse payload.
- Live verification on September 16, 2026 against league `1389331555339468800` and `/stats/nfl/regular/2026/1` reproduces Tyler Shough **197.49 → 197.5** and Jordan Love **197.27 → 197.3**, matching the supplied screenshot. McBride's provider TE reception/first-down counters produce **676.10**. This verifies those examples, not an independently certified match for every player; undocumented provider counters remain the source of truth.
- The response includes the league's finite `scoring_settings` as `baselines` for the scoring ledger, independently of the chosen ranking format.
- All QB/RB/WR/TE candidates in the published statistics payload are returned, **rostered or unrostered**, including zero/negative scores, without a top-30 cutoff. Players absent from the stats payload are not assigned fabricated zero scores. Rosters are used only to identify managers, never to filter players. Each import automatically excludes players marked **Out** or **IR** (including Injured Reserve), promoting the next-ranked eligible players. They remain visible and can be manually included before locking. Other injuries and byes still require review. Re-import to apply this to an existing unlocked pool; locked pools and historical assignments are unchanged. Names, positions, teams, and injuries come from the current dictionary, not a historical roster snapshot.
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

Returns `{ state, version }`. Commands use `commandSchema` in `src/lib/game.ts`; arbitrary client-supplied room state is not accepted. Import is a commissioner-controlled command, so a commissioner can intentionally choose imported content; this is not an independently audited Sleeper-proof system. Neither the client nor a spectator can submit a spin result.

To set or clear a player's nickname, use `{"type":"nickname","playerId":"<Sleeper player ID>","nickname":"The Buffalo"}` (use `""` to clear). The player must be in the currently imported list. `GameState.nicknames` is an optional ID-to-nickname map; assignment entries have an optional `nickname` snapshot. Both fields are absent in older saves and require no database migration.

Status codes: 400 invalid input, 401 invalid/missing session, 403 not a room commissioner, 404 missing room, 409 stale/racing version, 413 body over 256 KB, 422 invalid game transition, 503 unconfigured/unavailable storage or auth. On 409, refetch state and ask the user to retry; do not automatically reroll. If a network error occurs after submitting a command, refetch first because the write may already have succeeded.

### Commissioner access

`GET /api/room/commissioners?room=<uuid>` requires a signed-in user's bearer token and returns `{ canEdit, isOwner, commissioners }`. Only the owner receives additional commissioners as `{ userId, email }` entries; everyone else receives an empty list. An authenticated nonmember receives `canEdit: false`, while unauthenticated requests receive HTTP 401.

`POST /api/room/commissioners` requires the owner's bearer token and either `{ roomId, action: "add", email }` or `{ roomId, action: "remove", userId }`. It returns the updated access response. Email lookup is exact and case-insensitive against existing confirmed accounts. These operations never expose the account directory to spectators or co-commissioners and never modify the public game state.

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

#### Automatic player adds from Week 3

For room `69103cd4-0f84-4ce1-b9d1-dfb3096771bc`, league `1389331555339468800`, automatic adds default on from **2026 Week 3**. Week 2 stays manual. Only the signed-in operating commissioner's successful new player-spin response schedules a batch; visiting, reloading, reconnecting, historical imports, and spectator updates never queue old assignments. Adds wait until `startedAt + spinDurationMs`, including the tenth player awarded alongside the ninth spin. Scoring wheels never add players.

The arena switch can disable future automatic adds. While a reveal/add is pending, further game commands and week advancement wait. Any conflict, permission loss, stopped batch, or uncertain result pauses automatic additions visibly. Correct the roster manually if needed, then deliberately choose **Resume roster verification**: verified members are reconciled, not added again, and durable claims still forbid retrying an ambiguous mutation. Navigating within the app does not cancel the operating tab's scheduled live reveal; closing/reloading does, with no backlog replay. Use the manual assignment controls to reconcile after a reload.

Migration `202609170003_live_spin_sleeper.sql` follows the approved room's current 2026 round (Week 2 onward for manual operations), rejects unrevealed/current-history mismatches, and blocks cross-tab spins or week advancement while the latest player batch is unverified or any durable claim is uncertain. It preserves the existing league/player claim uniqueness and read-only imported roster ledger. No per-week redeployment is needed; season 2027 remains blocked.

#### Single-player live roster application

Only room `69103cd4-0f84-4ce1-b9d1-dfb3096771bc` is approved for league `1389331555339468800`. Other rooms and practice retain manual applied checklists. Single-player and user-triggered sequential bulk adds and outgoing-week cleanup are supported; no scheduled, transfer, scoring, starter, or historical-lineup writes exist.

In that room, opening **Player assignments** queries authenticated Sleeper GraphQL `me` and `league_rosters`. **Applied in Sleeper** reports observed current membership, including reserve/taxi, not the old manual flag. Sign-in/permission/provider failures show unavailable. Only commissioners can query status or apply. **Apply this player** immediately applies one eligible absent QB/RB/WR without a popup. **Apply to all** processes eligible assignments sequentially, checking each result before continuing; already-applied and blocked entries are skipped. A fresh eligibility conflict or error stops the run without retries. **Stop after this player**, leaving the tab, or closing the page prevents further queued requests but does not undo an in-flight move. TE history remains visible but new TE adds are blocked. Dropped assignments cannot be re-added. Adds affect the **current** Sleeper roster, never a historical lineup.

`POST /api/room/sleeper` accepts `{roomId, action:"status"}` or `{roomId, action:"apply", assignmentId}` with the caller's Supabase bearer token. The Next route forwards to `sleeper-player`; the Edge Function independently validates the token, rechecks room commissioner access and private binding, reads the assignment from storage, verifies the configured Sleeper account and exact roster ID, and checks real NFL player identity. Browser-supplied player/roster IDs are rejected. A player on another roster is a conflict, not an invitation to transfer.

### Open next week: outgoing Sleeper cleanup

**Open week N** first previews the actual stored outgoing season/week and eligible count, then asks for confirmation of real drops and advancement. Only that outgoing week's QB/RB/WR assignments are targets, including already-applied awards; TE, older assignments, imported `rosterHistory`, and unrelated roster members are never targets. No timer or page load initiates cleanup.

The authenticated `cleanup-preview` / `cleanup-step` actions accept only room, season, week, and version. Migration `202609170004_weekly_sleeper_cleanup.sql` derives and freezes targets server-side and keeps a durable per-room operation plus separate drop claims. Scoring restores, permanent applications, pending chaos, wheel reveal and pending adds are gates **before any drop**. The complete roster set is preflighted before each bounded server step; every target is rechecked immediately before its drop. A player moved to another roster stops the operation for commissioner review; the new roster is never dropped from.

Absent players are verified no-ops. Each external mutation is a single `commissioner` transaction with exact `k_drops`/`v_drops`, never an add/transfer. Verification requires absence plus the exact successful drop transaction; an ambiguous transport outcome is reconciled against transaction history, never blindly retried. If evidence remains uncertain, cleanup stays locked for commissioner review. A pre-send claimed operation whose worker dies also fails closed: it cannot infer whether a mutation was sent. No automatic override or claim deletion is provided.

**Stop after current player** pauses between bounded requests. **Resume cleanup** reauthorizes and reconciles, preserving completed audit rows. Errors, permission revocation, competing commissioners and expired workers cannot advance the week. Durable worker leases serialize requests; the room remains locked across pauses and reloads. Database guards reject direct next-week/spin/add bypasses. Completion rechecks scoring and all targets, verifies final absence, then atomically marks only cleaned assignments dropped and advances the week while preserving all history. Manual changes made directly in Sleeper cannot be transactionally locked with Postgres; a detected move or reappearance stops completion for review.

Deploy migration `004` and the updated `sleeper-player` Edge Function together after isolated SQL/mocked tests and `supabase db push --dry-run`. Deployment does not initiate cleanup or mutate Sleeper. Never use the live cleanup/apply actions as deployment smoke tests.

Deployed `004` and Edge version 3 to the environment-matched linked project `wtzvpbvtzfasgasdqtmy` after a dry run listing only `004`. Validation passed 88 unit/isolated PostgreSQL tests, production build, lint, and 20 focused Playwright tests on `localhost:3012`. Read-only before/after checks confirmed the live room remains version 80, 2026 Week 2, with 40 assignments and 30 imported history entries unchanged. No live Sleeper add/drop was executed. The Next.js frontend/API changes still require the normal application deployment when releasing beyond this checkout.

Before an add, a service-only RPC rechecks authorization, version and eligibility and creates a durable unique league/player/assignment claim. Migration `004` preserves all older add audits and permits a new award of that player only after the older award's verified, completed weekly cleanup; an uncertain add remains unique per league/player and blocks later awards. A second current-roster query precedes the single add-only mutation. A separate GraphQL query must verify membership before the latest locked room state is merged with `applied:true`. Current observations also set that historical lifecycle flag for already-present players; absence does not erase that history. The displayed live column never uses it as proof. During outgoing-week cleanup, adds and observation writes are paused; verified cleanup sets the dropped ledger flags atomically with advancement.

Claims and binding tables have RLS, no client grants and no Realtime publication. Claims retain requester, stored assignment, target roster, timestamps, verification state and transaction ID when verification succeeds. An uncertain claim is never retried or deleted automatically; it blocks duplicate writes and changes to that assignment until roster verification recovers it. If an add response or DB save is lost, **Refresh Sleeper status** recovers through observation without sending another mutation. If still absent, inspect Sleeper manually; do not clear/retry the claim blindly. A later disappearance after a verified add also cannot trigger a second add.

Deploy only after reviewing the migration dry-run:

```sh
supabase db push --dry-run
supabase db push
supabase functions deploy sleeper-player
```

The linked Edge secrets must contain `SLEEPER_SESSION_TOKEN`, `SLEEPER_USER_ID` (the approved commissioner `996938453788999680`), and `SLEEPER_LEAGUE_ID`. Do not put the Sleeper token in Next public variables, room state, logs or HAR files. The raw token is sent only in the Sleeper GraphQL Authorization header. Gateway JWT verification is disabled for this function to support asymmetric Supabase JWTs; the handler itself always verifies the caller using Supabase Auth. Deploy the Next application separately to publish the API/UI changes.

Validation must not perform real roster mutations. Unit tests mock the actual Edge handler, including timeout/recovery and concurrent-claim cases. SQL tests use an isolated local cluster. Focused browser tests use mocked external APIs and an isolated production server on `localhost:3012`:

```sh
WANDUBALL_TEST_PG_BIN=/path/to/postgresql/bin npm test
npm run build
npx playwright test --config=playwright.sleeper.config.ts
```

`GET /api/sleeper?leagueId=1389331555339468800&season=2026&week=2&statsSeason=2026&ranking=league`

Returns `{ players: Player[], managers: {id,name}[], season, week, leagueId, source, baselines }`. `statsSeason` is optional and defaults to `season`. Use the returned fields in an `import` command after review. HTTP 400 means invalid/unsupported input, 404 missing provider resource, 422 unavailable/ineligible ranking data or league setup, 502 provider failure/schema mismatch, and 503 rate limiting/service failure.

## Deploy on Vercel

1. Push the project to your own repository and import it into Vercel as a Next.js project.
2. Set all three Supabase environment variables for the intended deployment environments. `NEXT_PUBLIC_*` values are bundled at build time, so redeploy after changing them.
3. Apply the Supabase migration if not already applied. Create the confirmed commissioner account as above.
4. Deploy and use the generated `*.vercel.app` HTTPS URL. **No purchased domain is necessary.** Create a shared room on the deployed app and share that deployed URL.
5. Test from a second browser: it should read live results without signing in, and all writes should require the creator's account or an added co-commissioner's account.

Use separate Supabase projects for production and untrusted previews if needed. Protect deployments with Vercel's request/rate controls before broader public use: this starter does not implement per-user room quotas or distributed API rate limiting. Do not rely on an in-memory rate limiter for serverless protection.

## Validation

```sh
npm test
node --test tests/server.test.mjs
npm run lint
npm run build
```

Browser tests are available with `npm run test:e2e` using the existing Playwright configuration. On a fresh machine, run `npx playwright install chromium` once to download the browser. Commissioner browser tests mock all auth and room requests but require public Supabase environment variables so the browser client is enabled. For optional isolated PostgreSQL permission and concurrent row-lock tests, run `WANDUBALL_TEST_PG_BIN=/path/to/postgresql/bin node --test tests/commissioners.database.test.mjs`; this creates and cleans up its own local cluster and never connects to the configured Supabase project.

A live Supabase smoke test additionally requires real project credentials: create a room, fetch anonymously, verify a nonmember receives 403, add two confirmed co-commissioners, and confirm each can issue commands but cannot manage access or see other account emails. Send two commands with the same version and verify one receives 409; remove a co-commissioner and confirm their next command receives 403. Confirm direct anon/authenticated database writes and membership reads fail, and check spectator Realtime updates.
# Authorized round-label correction and imported roster evidence

Room `69103cd4-0f84-4ce1-b9d1-dfb3096771bc` (league `1389331555339468800`) was
originally labeled 2026 Week 1 while its current wheel round belongs to Week 2.
The applied surgical correction relabels the 40 existing assignments (including retained
TE history) and one current scoring change without rerolling or changing IDs,
flags, nicknames, spins, or the source **2026 Week 1 statistics**.

`rosterHistory` is a separate, read-only ledger reconstructed from 30 completed
Week 1 Sleeper commissioner-add transactions (10 QB, 10 RB, 10 WR). All 30 have
subsequent removal evidence in Week 2. Entries retain add/removal transaction IDs
and timestamps. These are roster movements, **not original wheel outcomes**;
no historical points, injury/team statistics, nicknames, or scoring changes are
invented. They are displayed in History and included in JSON exports, never in
the current apply checklist.

`scripts/room-week-correction.mjs` prepares this specific correction from a
private snapshot; it performs no network calls or writes. It rejects reruns,
unexpected counts, uncertain claims, conflicting duplicates, and other rooms.
Maintenance must lock the room, compare its full snapshot and version, call
`commit_room_command` as the stored owner, and relabel the linked binding and
claim snapshots in the same database transaction. Preserve every other audit
field. Migration `202609170002` keeps the imported ledger intact even when older
deployed servers omit it from unrelated commands.

The room's **round label** and the rankings' **statistics period** are separate:
correcting the round to Week 2 must not relabel the source Week 1 statistics.
This data correction itself neither expands Sleeper mutation authorization nor
performs any roster writes. The separately implemented live-add integration
supports current-round manual adds from 2026 Week 2 and automatic new-spin adds
from Week 3 after its own deployment; imported Week 1 history is never eligible.
Deploy the updated web app to display the imported ledger.

The initial live dry-run stopped on a concurrent room-version change (53 → 59).
After an explicitly authorized fresh-snapshot retry and review of deployed
migrations `202609170002`/`202609170003`, the correction committed atomically at
**version 79 → 80**. A live read verified Week 2, all 40 current assignments
(including all 30 existing applied flags), one unchanged scoring result relabeled
Week 2, the Week 2 binding, and all 28 verified claim snapshots relabeled without
changing any other audit fields. The 30 Week 1 imports all retain later removal
evidence. Full state/audit equality checks passed, and reruns reject the already
corrected round. No Sleeper mutation was performed by this maintenance.
