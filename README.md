# Wanduball

A fantasy-football league site built with Next.js, React, and Supabase.

Import Sleeper rankings using the league's scoring, review the top ten QB/RB/WR pools, randomly assign players, and spin weekly or permanent scoring rules. Assignments and rules are saved by week. Shared rooms update live for spectators; commissioners control the action. TE assignments are currently disabled.

Weekly setup ranks players by cumulative regular-season actual stats using the league's scoring (Sleeper Leaders > Season Stats), not weekly stats, projections, or season averages. The assignment week controls the ledger and bye-week eligibility, not the statistics period; shared rooms keep it fixed to the open round. Imports verify Sleeper's full regular-season schedule for the selected game season, flag bye-week players, and automatically exclude them alongside Out and IR players. The next eligible candidates refill the top ten. Bye players remain visible for review but cannot be included in the wheel; injury exclusions can still be overridden. If the schedule is unavailable or incomplete, the import fails explicitly rather than guessing byes. Week 1 retains an explicit previous-season statistics fallback, using the selected game season for byes. Existing pools and assignments are unchanged until an allowed re-import. The import API no longer accepts `statsWeek`; older clients receive an error prompting a refresh.

To correct an already-spun bye player in the open week, use **Replace bye assignment** under **Player assignments**. The schedule and fresh league-scoring rankings are verified without re-importing or unlocking the round. The same manager receives the highest-ranked unassigned player at that position who is not on bye, Out, IR, or manually excluded. The original award remains as read-only history linked to its replacement; other awards and scoring progress are unchanged. Corrections are not allowed during a spin or after the week closes. Remove an already-added original player from Sleeper first: the connected room verifies absence across all rosters, reserve and taxi slots; other rooms require manual confirmation. Corrections never send roster writes automatically. Apply the replacement separately using the usual checklist. Apply migration `202610070001_bye_assignment_corrections.sql` before deploying this feature to shared rooms; it protects correction history from older clients and reconciles both awards at weekly cleanup.

## Run locally

Use Node.js 22.

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Open http://localhost:3001. Without Supabase configuration, the app runs in local practice mode. Reading Sleeper rankings needs no credentials.

Production can open the live room at `/` without a redirect: set `DEFAULT_ROOM_ID=69103cd4-0f84-4ce1-b9d1-dfb3096771bc` in Vercel's **Production** environment and redeploy. Leave it unset in previews and local development to default to practice. `?room=<id>` selects another shared room; `?mode=practice` always selects local practice, even when a room is specified. Invalid room links and live-room loading failures show an error rather than falling back to practice.

Practice mode is not a separate backend environment. Use a separate Supabase project without production Sleeper credentials for shared preview testing.

## Shared rooms

Create a Supabase project and set these in `.env.local`:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server only)

Link the project and apply the migrations:

```sh
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push --dry-run
supabase db push
```

Enable email/password authentication and create a confirmed commissioner account in the Supabase dashboard. Restart the app, sign in, and create a room.

**Shared game data is public.** Spectators do not need an account. Only the owner and designated commissioners can make changes; only the owner can manage commissioner access.

## Sleeper roster automation

Roster writes use Sleeper's unofficial GraphQL API and are restricted to an explicitly authorized room, league, and commissioner account. Creating a shared room does not enable roster writes.

Deploy the `sleeper-player` Edge Function and configure `SLEEPER_SESSION_TOKEN`, `SLEEPER_USER_ID`, and `SLEEPER_LEAGUE_ID` as Supabase Edge secrets. Never put the session token or service-role key in browser variables, room data, or source control.

The connected room verifies roster membership, supports single/bulk adds, and automatically adds newly spun players from Week 3 onward. Advancing a week drops the outgoing assigned QB/RB/WR players before opening the next round, skipping players already absent. Players moved to another team block cleanup for commissioner review. Scoring changes and lineup edits remain manual in Sleeper. Scoring application/restore confirmations do not block week advancement, and cleanup leaves rule records unchanged.

## Checks

```sh
npm test
npm run lint
npm run build
npx playwright install chromium
npm run test:e2e
```

Database tests are optional locally: set `WANDUBALL_TEST_PG_BIN` to your PostgreSQL binary directory when running `npm test`. They create an isolated cluster, not a connection to Supabase. Commissioner browser tests require public Supabase variables and mock the network requests.

## Deploy

Import the repository into Vercel as a Next.js project and set the three Supabase environment variables above. Apply database migrations and deploy the Edge Function separately:

```sh
supabase functions deploy sleeper-player
```

Redeploy after changing public environment variables. Do not give untrusted preview deployments production secrets.
