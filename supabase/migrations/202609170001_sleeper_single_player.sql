begin;

create table public.sleeper_room_bindings (
  room_id uuid primary key references public.rooms(id),
  league_id text not null,
  season integer not null,
  week integer not null
);
insert into public.sleeper_room_bindings
  select id, '1389331555339468800', 2026, 1 from public.rooms
  where id = '69103cd4-0f84-4ce1-b9d1-dfb3096771bc';

-- A claim is never deleted or retried, including after an ambiguous timeout.
-- Uniqueness is league/player, not request ID: double clicks cannot duplicate adds.
create table public.sleeper_apply_claims (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.sleeper_room_bindings(room_id),
  league_id text not null,
  assignment_id text not null,
  player_id text not null,
  roster_id integer not null,
  requested_by uuid not null references auth.users(id),
  assignment jsonb not null,
  status text not null default 'uncertain' check (status in ('uncertain', 'verified')),
  transaction_id text,
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  unique (league_id, player_id)
);
alter table public.sleeper_room_bindings enable row level security;
alter table public.sleeper_apply_claims enable row level security;
revoke all on public.sleeper_room_bindings, public.sleeper_apply_claims from public, anon, authenticated, service_role;
grant select on public.sleeper_room_bindings, public.sleeper_apply_claims to service_role;

create function public.claim_sleeper_player(p_room_id uuid, p_user_id uuid, p_assignment_id text, p_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.rooms%rowtype;
  b public.sleeper_room_bindings%rowtype;
  a jsonb;
  c public.sleeper_apply_claims%rowtype;
begin
  select * into r from public.rooms where id = p_room_id for update;
  if not found then raise sqlstate 'PT404' using message = 'Room not found'; end if;
  if p_user_id is null or (r.owner_id <> p_user_id and not exists (
    select 1 from public.room_commissioners where room_id = p_room_id and user_id = p_user_id
  )) then raise sqlstate 'PT403' using message = 'Commissioner access required'; end if;
  select * into b from public.sleeper_room_bindings where room_id = p_room_id;
  if not found or r.state->>'leagueId' <> b.league_id then
    raise sqlstate 'PT422' using message = 'Room is not bound to this league';
  end if;
  if r.version <> p_version then raise sqlstate 'PT409' using message = 'Room changed; refresh status'; end if;
  select value into strict a from jsonb_array_elements(r.state->'assignments') where value->>'id' = p_assignment_id;
  if a->>'dropped' <> 'false' or a->>'season' <> b.season::text or a->>'week' <> b.week::text
    or r.state->>'season' <> b.season::text or r.state->>'week' <> b.week::text
    or a#>>'{player,position}' not in ('QB', 'RB', 'WR')
    or a#>>'{player,id}' !~ '^[1-9][0-9]{0,9}$'
    or a#>>'{manager,id}' !~ '^[1-9][0-9]{0,3}$' then
    raise sqlstate 'PT422' using message = 'Assignment is not eligible for a current roster add';
  end if;
  insert into public.sleeper_apply_claims(room_id, league_id, assignment_id, player_id, roster_id, requested_by, assignment)
    values (p_room_id, b.league_id, p_assignment_id, a#>>'{player,id}', (a#>>'{manager,id}')::integer, p_user_id, a)
    on conflict (league_id, player_id) do nothing returning * into c;
  if not found then raise sqlstate 'PT409' using message = 'An add was already claimed; verification only, never retry'; end if;
  return to_jsonb(c);
end;
$$;

create function public.verify_sleeper_player(p_claim_id uuid, p_user_id uuid, p_transaction_id text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c public.sleeper_apply_claims%rowtype;
  r public.rooms%rowtype;
  assignments jsonb;
begin
  select * into c from public.sleeper_apply_claims where id = p_claim_id;
  if not found then raise sqlstate 'PT404' using message = 'Claim not found'; end if;
  select * into r from public.rooms where id = c.room_id for update;
  if p_user_id is null or (r.owner_id <> p_user_id and not exists (
    select 1 from public.room_commissioners where room_id = c.room_id and user_id = p_user_id
  )) then raise sqlstate 'PT403' using message = 'Commissioner access required'; end if;
  update public.sleeper_apply_claims set status = 'verified', verified_at = now(),
    transaction_id = coalesce(p_transaction_id, transaction_id) where id = c.id;
  -- Merge into the locked latest state, never overwrite a concurrent room version.
  select jsonb_agg(case when a->>'id' = c.assignment_id
    and a#>>'{player,id}' = c.player_id and a#>>'{manager,id}' = c.roster_id::text
    and a->>'dropped' = 'false' then jsonb_set(a, '{applied}', 'true') else a end order by n)
    into assignments from jsonb_array_elements(r.state->'assignments') with ordinality as items(a,n);
  if assignments is distinct from r.state->'assignments' then
    update public.rooms set state = jsonb_set(state, '{assignments}', assignments), version = version + 1 where id = r.id;
  end if;
end;
$$;

alter function public.commit_room_command(uuid, uuid, integer, jsonb) rename to commit_room_command_unlinked;
-- Preserve the historical applied lifecycle flag for manual end-of-week cleanup.
-- The UI uses the fresh membership response (not this flag) as live status.
create function public.observe_sleeper_players(p_room_id uuid, p_user_id uuid, p_version integer, p_present_ids jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.rooms%rowtype; assignments jsonb;
begin
  select * into r from public.rooms where id = p_room_id for update;
  if not exists (select 1 from public.sleeper_room_bindings where room_id = p_room_id and league_id = r.state->>'leagueId') then
    raise sqlstate 'PT422' using message = 'Room is not bound';
  end if;
  if p_user_id is null or (r.owner_id <> p_user_id and not exists (
    select 1 from public.room_commissioners where room_id = p_room_id and user_id = p_user_id
  )) then raise sqlstate 'PT403' using message = 'Commissioner access required'; end if;
  if r.version <> p_version then return; end if;
  select jsonb_agg(case when p_present_ids ? (a->>'id') then jsonb_set(a, '{applied}', 'true') else a end order by n)
    into assignments from jsonb_array_elements(r.state->'assignments') with ordinality as items(a,n);
  if assignments is not null and assignments is distinct from r.state->'assignments' then
    update public.rooms set state = jsonb_set(state, '{assignments}', assignments), version = version + 1 where id = r.id;
  end if;
end;
$$;
create function public.commit_room_command(p_room_id uuid, p_user_id uuid, p_expected_version integer, p_new_state jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.rooms%rowtype;
begin
  select * into r from public.rooms where id = p_room_id for update;
  if exists (select 1 from public.sleeper_room_bindings where room_id = p_room_id) then
    if p_new_state->>'leagueId' is distinct from r.state->>'leagueId' then
      raise sqlstate 'PT422' using message = 'The live Sleeper league binding cannot be changed';
    end if;
    if exists (
      select 1 from jsonb_array_elements(r.state->'assignments') a
      left join jsonb_array_elements(p_new_state->'assignments') n on n->>'id' = a->>'id'
      where n->'applied' is distinct from a->'applied'
    ) then raise sqlstate 'PT422' using message = 'Applied status requires Sleeper verification'; end if;
    if exists (
      select 1 from public.sleeper_apply_claims c
      left join jsonb_array_elements(p_new_state->'assignments') a on a->>'id' = c.assignment_id
      where c.room_id = p_room_id and c.status = 'uncertain'
        and (a is null or (a - 'nickname' - 'applied') is distinct from (c.assignment - 'nickname' - 'applied'))
    ) then raise sqlstate 'PT409' using message = 'An uncertain external add requires verification before changing this assignment'; end if;
  end if;
  return public.commit_room_command_unlinked(p_room_id, p_user_id, p_expected_version, p_new_state);
end;
$$;
revoke all on function public.commit_room_command_unlinked(uuid, uuid, integer, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.claim_sleeper_player(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.verify_sleeper_player(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.commit_room_command(uuid, uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.claim_sleeper_player(uuid, uuid, text, integer) to service_role;
grant execute on function public.verify_sleeper_player(uuid, uuid, text) to service_role;
grant execute on function public.commit_room_command(uuid, uuid, integer, jsonb) to service_role;
revoke all on function public.observe_sleeper_players(uuid, uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.observe_sleeper_players(uuid, uuid, integer, jsonb) to service_role;
commit;
