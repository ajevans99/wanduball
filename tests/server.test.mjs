import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const roomId = "3c1f7a16-8257-41aa-8eaa-c0439f69b2a7";
const ownerId = "45d04bc0-ee26-41d4-b5d5-f9b14858c53e";

// Reuse the installed TypeScript compiler to exercise the real route modules
// outside Next, resolving its path alias and server-only build marker in memory.
function loader() {
  const cache = new Map();
  return function load(relative) {
    const filename = path.resolve(root, relative);
    if (cache.has(filename)) return cache.get(filename).exports;
    const compiled = { exports: {} };
    cache.set(filename, compiled);
    const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    });
    const localRequire = specifier => {
      if (specifier === "server-only") return {};
      if (specifier.startsWith("@/")) return load(`src/${specifier.slice(2)}.ts`);
      if (specifier.startsWith(".")) return load(path.resolve(path.dirname(filename), `${specifier}.ts`));
      return require(specifier);
    };
    compileFunction(outputText, ["exports", "require", "module"], { filename })(compiled.exports, localRequire, compiled);
    return compiled.exports;
  };
}

function mockFetch(context, implementation) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  context.after(() => { globalThis.fetch = original; });
}

function configure(context) {
  for (const [key, value] of Object.entries({
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-test-key",
    SUPABASE_SERVICE_ROLE_KEY: "server-test-key",
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    context.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

function post(body, token = "owner-token") {
  return new Request("http://localhost/api/room", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function database(context) {
  configure(context);
  const load = loader();
  let row = { id: roomId, owner_id: ownerId, state: load("src/lib/seed.ts").initialState(), version: 0 };
  const calls = [];
  mockFetch(context, async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, init });
    if (url.pathname === "/auth/v1/user") {
      const token = new Headers(init.headers).get("authorization");
      if (token === "Bearer expired-token") {
        return Response.json({ message: "JWT expired" }, { status: 401 });
      }
      return Response.json({ id: token === "Bearer owner-token" ? ownerId : "other-user" });
    }
    assert.equal(url.pathname, "/rest/v1/rooms");
    if (method === "POST") {
      row = { id: roomId, ...JSON.parse(init.body) };
      return Response.json(row, { status: 201 });
    }
    if (method === "PATCH") {
      assert.equal(url.searchParams.get("id"), `eq.${roomId}`);
      assert.equal(url.searchParams.get("owner_id"), `eq.${ownerId}`);
      assert.equal(new Headers(init.headers).get("apikey"), "server-test-key");
      if (url.searchParams.get("version") !== `eq.${row.version}`) return Response.json([]);
      row = { ...row, ...JSON.parse(init.body) };
      return Response.json([row]);
    }
    // Return snapshots so two commands can read the same version before CAS.
    return Response.json(url.searchParams.get("id") === `eq.${roomId}` ? [row] : []);
  });
  return { route: load("src/app/api/room/route.ts"), calls, row: () => row };
}

test("room create and public read omit auth data; real rooms have no demo players", async context => {
  const db = database(context);
  const created = await db.route.POST(post({ type: "create" }));
  assert.equal(created.status, 201);
  const result = await created.json();
  assert.equal(result.roomId, roomId);
  assert.equal(result.version, 0);
  assert.deepEqual(result.state.players, []);
  assert.deepEqual(result.state.assignments, []);
  assert.deepEqual(result.state.changes, []);
  assert.equal(result.state.managers.length, 10);
  assert.match(result.state.source, /Awaiting Sleeper/);
  assert.equal(result.owner_id, undefined);
  const read = await db.route.GET(new Request(`http://localhost/api/room?room=${roomId}`));
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "no-store");
  assert.deepEqual(Object.keys(await read.json()).sort(), ["state", "version"]);
});

test("room authorization rejects nonowners, missing sessions, and expired sessions", async context => {
  const db = database(context);
  const command = { type: "command", roomId, version: 0, command: { type: "lock", position: "QB" } };
  assert.equal((await db.route.POST(post(command, "other-token"))).status, 403);
  assert.equal((await db.route.POST(post(command, "expired-token"))).status, 401);
  assert.equal((await db.route.POST(new Request("http://localhost/api/room", { method: "POST" }))).status, 401);
  assert.equal(db.calls.filter(call => call.method === "PATCH").length, 0);
});

test("room CAS permits one concurrent command and rejects stale retries", async context => {
  const db = database(context);
  const body = { type: "command", roomId, version: 0, command: { type: "lock", position: "QB" } };
  const replies = await Promise.all([db.route.POST(post(body)), db.route.POST(post(body))]);
  assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);
  assert.equal(db.row().version, 1);
  assert.deepEqual(db.row().state.locked, ["QB"]);
  assert.equal((await db.route.POST(post(body))).status, 409);
});

test("room invalid input, invalid transitions, oversized payloads and missing rooms are explicit", async context => {
  const db = database(context);
  assert.equal((await db.route.GET(new Request("http://localhost/api/room?room=bad"))).status, 400);
  assert.equal((await db.route.GET(new Request("http://localhost/api/room?room=079507ab-716d-4a06-b193-62f070e70408"))).status, 404);
  assert.equal((await db.route.POST(post("{"))).status, 400);
  assert.equal((await db.route.POST(post("x".repeat(256 * 1024 + 1)))).status, 413);
  const invalid = await db.route.POST(post({
    type: "command", roomId, version: 0, command: { type: "assign", position: "QB" },
  }));
  assert.equal(invalid.status, 422);
  assert.match((await invalid.json()).error, /lock/);
});

test("unconfigured rooms return 503 without leaking server details", async context => {
  configure(context);
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  const route = loader()("src/app/api/room/route.ts");
  const response = await route.GET(new Request(`http://localhost/api/room?room=${roomId}`));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /not configured/);
});

function sleeper(context, overrides = {}) {
  const dictionary = {};
  const stats = {};
  for (const position of ["QB", "RB", "WR", "TE"]) {
    for (let i = 0; i < 35; i++) {
      const id = `${position}-${i}`;
      dictionary[id] = { full_name: `${position} Player ${i}`, position, team: null, injury_status: i === 0 ? "Out" : null };
      stats[id] = { pts_ppr: 100 - i, pts_half_ppr: 80 - i, pts_std: 60 - i, nullable_stat: null };
    }
  }
  const payloads = {
    "league/123": { league_id: "123", sport: "nfl", season: "2026", total_rosters: 10, scoring_settings: { rec: 1, rush_yd: 0.1 } },
    "state/nfl": { season: "2026", season_type: "regular", week: 3 },
    "league/123/users": Array.from({ length: 10 }, (_, i) => ({ user_id: String(i), display_name: `Owner ${i}`, metadata: null })),
    "league/123/rosters": Array.from({ length: 10 }, (_, i) => ({ roster_id: i + 1, owner_id: String(i) })),
    "players/nfl": dictionary,
    "stats/nfl/regular/2026/1": stats,
    "stats/nfl/regular/2026/2": stats,
    "stats/nfl/regular/2025": stats,
    ...overrides,
  };
  const calls = [];
  mockFetch(context, async (input, init) => {
    const endpoint = new URL(input).pathname.replace("/v1/", "");
    calls.push({ endpoint, init });
    assert.ok(endpoint in payloads, `unexpected upstream request: ${endpoint}`);
    const value = payloads[endpoint];
    return value instanceof Response ? value : Response.json(value);
  });
  const load = loader();
  return { route: load("src/app/api/sleeper/route.ts"), calls };
}

const query = "leagueId=123&season=2026&week=3&statsSeason=2026&ranking=ppr";
function requestSleeper(route, search = query) {
  return route.GET(new Request(`http://localhost/api/sleeper?${search}`));
}

test("Sleeper sums only completed previous weeks, returns 30 per position and preserves injuries", async context => {
  const service = sleeper(context);
  const response = await requestSleeper(service.route);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.players.length, 120);
  assert.equal(result.players[0].points, 200);
  assert.equal(result.players[0].injury, "Out");
  assert.equal(result.players[0].team, "FA");
  assert.equal(result.managers.length, 10);
  assert.deepEqual(result.managers[0], { id: "1", name: "Owner 0" });
  assert.deepEqual(result.baselines, { rec: 1, rush_yd: 0.1 });
  assert.match(result.source, /season-to-date.*before week 3/);
  assert.deepEqual(service.calls.filter(call => call.endpoint.startsWith("stats/")).map(call => call.endpoint).sort(), [
    "stats/nfl/regular/2026/1", "stats/nfl/regular/2026/2",
  ]);
  assert.equal(service.calls.find(call => call.endpoint === "players/nfl").init.next.revalidate, 86400);
});

test("Sleeper explicit previous-season totals keep game setup season/week distinct", async context => {
  const service = sleeper(context);
  const response = await requestSleeper(service.route, "leagueId=123&season=2026&week=1&statsSeason=2025&ranking=std");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.season, 2026);
  assert.equal(result.week, 1);
  assert.equal(result.players[0].points, 60);
  assert.match(result.source, /2025 previous-season/);
  assert.match(result.source, /2026 week 1/);
  assert.equal(service.calls.filter(call => call.endpoint.startsWith("stats/")).length, 1);
});

test("Sleeper rejects week-one same-season, future weeks, unsupported league rankings and invalid input", async context => {
  const service = sleeper(context);
  let response = await requestSleeper(service.route, query.replace("week=3", "week=1"));
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /statsSeason=2025/);
  assert.equal(service.calls.length, 0);
  response = await requestSleeper(service.route, query.replace("week=3", "week=4"));
  assert.equal(response.status, 422);
  assert.equal((await requestSleeper(service.route, query.replace("ranking=ppr", "ranking=league"))).status, 400);
  assert.equal((await requestSleeper(service.route, query.replace("leagueId=123", "leagueId=not-a-league"))).status, 400);
});

test("Sleeper rejects missing owners rather than guessing", async context => {
  const service = sleeper(context, { "league/123/rosters": [{ roster_id: 1, owner_id: null }] });
  const response = await requestSleeper(service.route);
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /distinct owners/);
});

test("Sleeper rejects missing scoring baselines rather than resetting them to zero", async context => {
  const service = sleeper(context, {
    "league/123": { league_id: "123", sport: "nfl", season: "2026", total_rosters: 10, scoring_settings: null },
  });
  const response = await requestSleeper(service.route);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /baselines are not guessed/);
});

test("Sleeper does not replace missing statistics with zero or demo scores", async context => {
  const service = sleeper(context, { "stats/nfl/regular/2026/2": {} });
  const response = await requestSleeper(service.route);
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /no positive fantasy statistics/);
});

test("Sleeper upstream failure surfaces without fallback", async context => {
  const service = sleeper(context, { "league/123": new Response("unavailable", { status: 503 }) });
  const response = await requestSleeper(service.route);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /HTTP 503/);
});
