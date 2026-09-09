import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Optional integration run against an isolated local PostgreSQL cluster:
// WANDUBALL_TEST_PG_BIN=/path/to/postgresql/bin node --test tests/commissioners.database.test.mjs
// Never connects to a configured Supabase instance or an existing database.
const pgBin = process.env.WANDUBALL_TEST_PG_BIN;
const root = fileURLToPath(new URL("..", import.meta.url));
const owner = "00000000-0000-4000-8000-000000000001";
const member = "00000000-0000-4000-8000-000000000002";
const second = "00000000-0000-4000-8000-000000000003";
const spectator = "00000000-0000-4000-8000-000000000004";
const room = "00000000-0000-4000-8000-000000000010";

test("commissioner SQL privileges, access, and real row-lock/CAS races", { skip: !pgBin }, async context => {
  const directory = path.join(root, `.commissioners-db-${process.pid}`);
  await mkdir(directory, { mode: 0o700 });
  let postgres;
  let exited;
  const clients = new Set();
  context.after(async () => {
    for (const client of clients) {
      client.stdin.destroy();
      client.kill("SIGTERM");
    }
    if (postgres && postgres.exitCode === null) {
      postgres.kill("SIGTERM");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  execFileSync(path.join(pgBin, "initdb"), ["-D", `${directory}/data`, "-U", "postgres", "--auth=trust", "--no-locale"], { stdio: "pipe" });
  postgres = spawn(path.join(pgBin, "postgres"), [
    "-D", `${directory}/data`, "-k", directory, "-c", "listen_addresses=", "-c", "wal_level=logical",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  exited = once(postgres, "exit");
  let logs = "";
  postgres.stderr.on("data", chunk => { logs += chunk; });
  const args = ["-h", directory, "-U", "postgres", "-d", "postgres", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1"];
  const query = sql => execFileSync(path.join(pgBin, "psql"), [...args, "-c", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { query("select 1"); ready = true; break; } catch { await delay(50); }
  }
  assert.ok(ready, logs);

  query(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
  `);
  for (const migration of ["202609090001_create_rooms.sql", "202609090002_room_commissioners.sql"]) {
    query(await readFile(path.join(root, "supabase/migrations", migration), "utf8"));
  }
  query(`
    insert into auth.users values
      ('${owner}', 'owner@example.com', now()),
      ('${member}', 'member@example.com', now()),
      ('${second}', 'second@example.com', now()),
      ('${spectator}', 'pending@example.com', null);
    insert into public.rooms (id, owner_id, state) values ('${room}', '${owner}', '{}');
  `);
  const service = sql => query(`set role service_role; ${sql}`).replace(/^SET\n/, "");
  const access = actor => JSON.parse(service(`select public.room_commissioner_access('${room}', '${actor}')`));
  const add = (email, actor = owner) =>
    JSON.parse(service(`select public.manage_room_commissioner('${room}', '${actor}', 'add', '${email}')`));
  const remove = actor => service(`select public.manage_room_commissioner('${room}', '${owner}', 'remove', null, '${actor}')`);
  const expectSQLState = (sql, code, role = "service_role") => {
    query(`set role ${role}; do $$ begin
      begin ${sql}; exception when sqlstate '${code}' then return; end;
      raise exception 'Expected SQLSTATE ${code}';
    end $$;`);
  };
  const commit = (actor, version) => `select public.commit_room_command('${room}', '${actor}', ${version}, '{"committed":true}')`;

  await context.test("membership and functions are service-only; owner and version guards survive", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        assert.equal(query(`select has_table_privilege('${role}', 'public.room_commissioners', '${privilege}')`), "f");
      }
      for (const signature of [
        "public.room_commissioner_access(uuid,uuid)",
        "public.manage_room_commissioner(uuid,uuid,text,text,uuid)",
        "public.commit_room_command(uuid,uuid,integer,jsonb)",
      ]) {
        assert.equal(query(`select has_function_privilege('${role}', '${signature}', 'EXECUTE')`), "f");
        assert.equal(query(`select has_function_privilege('service_role', '${signature}', 'EXECUTE')`), "t");
      }
      expectSQLState(`perform public.room_commissioner_access('${room}', '${owner}')`, "42501", role);
      expectSQLState("perform * from public.room_commissioners", "42501", role);
    }
    assert.equal(query("select relrowsecurity from pg_class where oid = 'public.room_commissioners'::regclass"), "t");
    assert.equal(query("select count(*) from pg_publication_tables where tablename='room_commissioners'"), "0");
    assert.equal(query("select has_table_privilege('service_role', 'public.rooms', 'UPDATE')"), "t");
    for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
      assert.equal(query(`select has_table_privilege('service_role', 'public.room_commissioners', '${privilege}')`), "f");
    }
    expectSQLState(`update public.rooms set owner_id='${member}', version=version+1 where id='${room}'`, "P0001", "postgres");
    expectSQLState(`update public.rooms set state='{}' where id='${room}'`, "P0001", "postgres");
  });

  await context.test("existing owner works without backfill; only owner sees additional member emails", () => {
    assert.deepEqual(access(owner), { canEdit: true, isOwner: true, commissioners: [] });
    assert.equal(add(" MEMBER@Example.com ").commissioners.length, 1);
    assert.equal(add("member@example.com").commissioners.length, 1);
    assert.equal(add("second@example.com").commissioners.length, 2);
    assert.deepEqual(access(member), { canEdit: true, isOwner: false, commissioners: [] });
    assert.deepEqual(access(spectator), { canEdit: false, isOwner: false, commissioners: [] });
    assert.deepEqual(access(owner).commissioners, [
      { userId: member, email: "member@example.com" },
      { userId: second, email: "second@example.com" },
    ]);
    assert.equal(query(`select version from public.rooms where id='${room}'`), "0");
  });

  await context.test("owner-only management, confirmed email lookup, and permanent creator access", () => {
    for (const actor of [member, spectator]) {
      expectSQLState(`perform public.manage_room_commissioner('${room}', '${actor}', 'add', 'unknown@example.com')`, "PT403");
      expectSQLState(`perform public.manage_room_commissioner('${room}', '${actor}', 'remove', null, '${member}')`, "PT403");
    }
    expectSQLState(`perform public.manage_room_commissioner('${room}', '${owner}', 'add', 'unknown@example.com')`, "PT410");
    expectSQLState(`perform public.manage_room_commissioner('${room}', '${owner}', 'add', 'pending@example.com')`, "PT422");
    expectSQLState(`perform public.manage_room_commissioner('${room}', '${owner}', 'add', 'owner@example.com')`, "PT400");
    expectSQLState(`perform public.manage_room_commissioner('${room}', '${owner}', 'remove', null, '${owner}')`, "PT400");
    expectSQLState(`perform public.manage_room_commissioner('${room}', null, 'add', 'member@example.com')`, "PT403");
    expectSQLState(`perform public.room_commissioner_access('${spectator}', '${owner}')`, "PT404");
    expectSQLState(`perform public.commit_room_command('${room}', '${spectator}', 0, '{}')`, "PT403");
    expectSQLState(`perform public.commit_room_command('${room}', null, 0, '{}')`, "PT403");
  });

  await context.test("membership is not capped at three commissioners", () => {
    for (let index = 5; index <= 8; index++) {
      const id = `00000000-0000-4000-8000-00000000000${index}`;
      query(`insert into auth.users values ('${id}', 'extra${index}@example.com', now())`);
      add(`extra${index}@example.com`);
    }
    assert.equal(access(owner).commissioners.length, 6);
    assert.equal(query(`select version from public.rooms where id='${room}'`), "0");
    query("delete from auth.users where email like 'extra%@example.com'");
    assert.equal(access(owner).commissioners.length, 2);
  });

  function client() {
    const child = spawn(path.join(pgBin, "psql"), args, { stdio: ["pipe", "pipe", "pipe"] });
    clients.add(child);
    let output = "";
    let error = "";
    let finished = false;
    const waiters = [];
    child.stdout.on("data", chunk => {
      output += chunk;
      for (const resolve of waiters.splice(0)) resolve();
    });
    child.stderr.on("data", chunk => { error += chunk; });
    const completion = once(child, "exit").then(([code]) => {
      finished = true;
      clients.delete(child);
      for (const resolve of waiters.splice(0)) resolve();
      return { code, output, error };
    });
    return {
      write: sql => child.stdin.write(`${sql}\n`),
      end: sql => child.stdin.end(`${sql}\n`),
      completion,
      isFinished: () => finished,
      async marker(value) {
        const timeout = AbortSignal.timeout(5000);
        while (!output.includes(value)) {
          assert.equal(finished, false, error);
          await Promise.race([
            new Promise(resolve => waiters.push(resolve)),
            delay(50, undefined, { signal: timeout }),
          ]);
        }
      },
    };
  }

  await context.test("a pending command waits for revocation and then fails its atomic authorization check", async () => {
    const revoker = client();
    revoker.write(`begin; set role service_role;
      select public.manage_room_commissioner('${room}', '${owner}', 'remove', null, '${member}');
      \\echo membership_locked`);
    await revoker.marker("membership_locked");
    const writer = client();
    writer.end(`set role service_role; ${commit(member, 0)};`);
    await delay(100);
    assert.equal(writer.isFinished(), false, "command must wait for the membership transaction");
    revoker.end("commit;");
    assert.equal((await revoker.completion).code, 0);
    const result = await writer.completion;
    assert.notEqual(result.code, 0);
    assert.match(result.error, /Commissioner access required/);
    assert.equal(query(`select version from public.rooms where id='${room}'`), "0");
    assert.equal(access(member).canEdit, false);
  });

  await context.test("two different commissioners cannot commit the same version", async () => {
    add("member@example.com");
    const first = client();
    first.write(`begin; set role service_role; ${commit(member, 0)};
      \\echo command_locked`);
    await first.marker("command_locked");
    const secondWriter = client();
    secondWriter.end(`set role service_role; ${commit(second, 0)};`);
    await delay(100);
    assert.equal(secondWriter.isFinished(), false);
    first.end("commit;");
    assert.equal((await first.completion).code, 0);
    const result = await secondWriter.completion;
    assert.notEqual(result.code, 0);
    assert.match(result.error, /Room version changed/);
    assert.equal(query(`select version from public.rooms where id='${room}'`), "1");
    assert.equal(JSON.parse(service(commit(owner, 1))).version, 2, "owner path remains usable");
    remove(member);
    remove(member);
    assert.equal(query(`select version from public.rooms where id='${room}'`), "2");
  });

  await context.test("foreign keys cascade account and room deletion without orphan memberships", () => {
    query(`delete from auth.users where id='${second}'`);
    assert.deepEqual(access(owner).commissioners, []);
    add("member@example.com");
    query(`delete from public.rooms where id='${room}'`);
    assert.equal(query("select count(*) from public.room_commissioners"), "0");
  });
});
