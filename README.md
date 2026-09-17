# Wanduball

A fantasy-football league site built with Next.js, React, and Supabase.

Import Sleeper rankings using the league's scoring, review the top ten QB/RB/WR pools, randomly assign players, and spin weekly or permanent scoring rules. Assignments and rules are saved by week. Shared rooms update live for spectators; commissioners control the action. TE assignments are currently disabled.

## Run locally

Use Node.js 22.

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Open http://localhost:3001. Without Supabase configuration, the app runs in local practice mode. Reading Sleeper rankings needs no credentials.

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

The connected room verifies roster membership, supports single/bulk adds, and automatically adds newly spun players from Week 3 onward. Advancing a week drops the outgoing assigned QB/RB/WR players before opening the next round. Players moved to another team block cleanup for commissioner review. Scoring changes and lineup edits remain manual in Sleeper.

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
