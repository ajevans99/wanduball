begin;

create table public.sleeper_cleanups (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.sleeper_room_bindings(room_id),
  season integer not null,
  week integer not null,
  targets jsonb not null,
  status text not null default 'active' check (status in ('active', 'completed')),
  worker uuid,
  lease_until timestamptz,
  requested_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error text,
  unique(room_id, season, week)
);
create table public.sleeper_drop_claims (
  id uuid primary key default gen_random_uuid(),
  cleanup_id uuid not null references public.sleeper_cleanups(id),
  assignment_id text not null,
  player_id text not null,
  roster_id integer not null,
  status text not null default 'uncertain' check(status in ('uncertain', 'verified')),
  transaction_id text,
  evidence text check(evidence in ('already-absent', 'transaction')),
  requested_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  unique(cleanup_id, player_id)
);
alter table public.sleeper_cleanups enable row level security;
alter table public.sleeper_drop_claims enable row level security;
revoke all on public.sleeper_cleanups, public.sleeper_drop_claims from public, anon, authenticated, service_role;
grant select on public.sleeper_cleanups, public.sleeper_drop_claims to service_role;

create function public.sleeper_cleanup_ready(s jsonb) returns void
language plpgsql set search_path = '' as $$
begin
  if s->>'season' <> '2026' or (s->>'week')::integer not between 2 and 17 then
    raise sqlstate 'PT422' using message = 'Cleanup requires an open 2026 week before week 18';
  end if;
  if s#>>'{pending,duration}' is not null or s#>>'{pending,ruleId}' is not null
    or exists (select 1 from jsonb_array_elements(s->'changes') c
      where (c#>>'{rule,duration}' = 'Weekly' and c->>'reverted' <> 'true')
         or (c#>>'{rule,duration}' = 'Permanent' and c->>'applied' <> 'true')) then
    raise sqlstate 'PT422' using message = 'Confirm weekly scoring restores and permanent rule applications; finish the chaos round first';
  end if;
  if extract(epoch from clock_timestamp()) * 1000 < coalesce((s#>>'{lastSpin,startedAt}')::numeric, 0) + 5000 then
    raise sqlstate 'PT409' using message = 'Wait for the wheel reveal';
  end if;
end;
$$;

-- All state-changing phases lock the room, reauthorize, and fence concurrent workers.
-- No public caller can provide cleanup targets or mark cleanup complete.
create function public.sleeper_cleanup_step(
  p_room_id uuid, p_user_id uuid, p_season integer, p_week integer,
  p_version integer, p_phase text, p_worker uuid default null,
  p_assignment_id text default null, p_transaction_id text default null,
  p_evidence text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.rooms%rowtype; op public.sleeper_cleanups%rowtype;
  target jsonb; targets jsonb; claim public.sleeper_drop_claims%rowtype; s jsonb;
begin
  select * into r from public.rooms where id = p_room_id for update;
  if not found then raise sqlstate 'PT404' using message = 'Room not found'; end if;
  if p_user_id is null or (r.owner_id <> p_user_id and not exists (
    select 1 from public.room_commissioners where room_id = p_room_id and user_id = p_user_id
  )) then raise sqlstate 'PT403' using message = 'Commissioner access required'; end if;
  if p_room_id <> '69103cd4-0f84-4ce1-b9d1-dfb3096771bc'::uuid
    or r.state->>'leagueId' <> '1389331555339468800'
    or not exists (select 1 from public.sleeper_room_bindings where room_id = p_room_id and league_id = '1389331555339468800') then
    raise sqlstate 'PT422' using message = 'Unapproved cleanup room or league';
  end if;
  select * into op from public.sleeper_cleanups where room_id = p_room_id and season = p_season and week = p_week;
  if op.status = 'completed' then
    return jsonb_build_object('completed', true, 'room', to_jsonb(r), 'operation', to_jsonb(op));
  end if;
  if r.state->>'season' <> p_season::text or r.state->>'week' <> p_week::text then
    raise sqlstate 'PT409' using message = 'Outgoing week changed; preview again';
  end if;
  perform public.sleeper_cleanup_ready(r.state);
  if exists (select 1 from public.sleeper_apply_claims where room_id = p_room_id and status = 'uncertain')
    or (p_week >= 3 and exists (select 1 from jsonb_array_elements(r.state->'assignments') a
      where a->>'season' = p_season::text and a->>'week' = p_week::text
      and a#>>'{player,position}' in ('QB', 'RB', 'WR')
      and (a->>'id' = r.state#>>'{lastSpin,id}' or a->>'awardedWithSpinId' = r.state#>>'{lastSpin,id}')
      and a->>'applied' <> 'true')) then
    raise sqlstate 'PT409' using message = 'Verify pending Sleeper adds before cleanup';
  end if;
  select coalesce(jsonb_agg(a order by a->>'id'), '[]'::jsonb) into targets
    from jsonb_array_elements(r.state->'assignments') a
    where a->>'season' = p_season::text and a->>'week' = p_week::text
      and a#>>'{player,position}' in ('QB','RB','WR');
  if exists (select 1 from jsonb_array_elements(targets) a
    where a#>>'{player,id}' !~ '^[1-9][0-9]{0,9}$' or a#>>'{manager,id}' !~ '^[1-9][0-9]{0,3}$')
    or (select count(*) <> count(distinct a#>>'{player,id}') or count(*) <> count(distinct a->>'id')
      from jsonb_array_elements(targets) a) then
    raise sqlstate 'PT422' using message = 'Invalid or duplicate cleanup assignments';
  end if;
  if op.id is not null and op.targets is distinct from targets then
    raise sqlstate 'PT409' using message = 'Cleanup assignments changed; commissioner review required';
  end if;
  if p_phase = 'preview' then
    return jsonb_build_object('targets', targets, 'version', r.version, 'week', p_week, 'season', p_season, 'operation', to_jsonb(op));
  end if;
  if p_phase = 'acquire' then
    if op.id is null then
      if r.version <> p_version then raise sqlstate 'PT409' using message = 'Room changed; preview again'; end if;
      insert into public.sleeper_cleanups(room_id,season,week,targets,requested_by)
        values(p_room_id,p_season,p_week,targets,p_user_id) returning * into op;
    end if;
    if op.lease_until > clock_timestamp() then
      raise sqlstate 'PT409' using message = 'Another commissioner is running cleanup; wait before resuming';
    end if;
    update public.sleeper_cleanups set worker = gen_random_uuid(), lease_until = clock_timestamp() + interval '90 seconds'
      where id = op.id returning * into op;
    return to_jsonb(op);
  end if;
  if op.id is null or p_worker is null or op.worker is distinct from p_worker or op.lease_until <= clock_timestamp() then
    raise sqlstate 'PT409' using message = 'Cleanup worker expired; resume verification';
  end if;
  if p_phase = 'release' then
    update public.sleeper_cleanups set worker = null, lease_until = null where id = op.id;
    return '{}'::jsonb;
  elsif p_phase = 'flag' then
    update public.sleeper_cleanups set last_error = left(p_evidence,2000) where id = op.id;
    return '{}'::jsonb;
  elsif p_phase in ('claim','verify','authorize') then
    select value into strict target from jsonb_array_elements(op.targets) where value->>'id' = p_assignment_id;
    select * into claim from public.sleeper_drop_claims where cleanup_id = op.id and assignment_id = p_assignment_id;
    if p_phase = 'claim' then
      if claim.id is not null then raise sqlstate 'PT409' using message = 'Drop already claimed; reconcile only'; end if;
      insert into public.sleeper_drop_claims(cleanup_id,assignment_id,player_id,roster_id,requested_by)
        values(op.id,p_assignment_id,target#>>'{player,id}',(target#>>'{manager,id}')::integer,p_user_id) returning * into claim;
    elsif p_phase = 'verify' then
      if claim.id is null or p_evidence not in ('already-absent','transaction')
        or (p_evidence = 'transaction' and coalesce(p_transaction_id,'') = '') then
        raise sqlstate 'PT422' using message = 'Exact drop evidence required';
      end if;
      update public.sleeper_drop_claims set status = 'verified', transaction_id = p_transaction_id,
        evidence = p_evidence, verified_at = now() where id = claim.id returning * into claim;
    end if;
    return to_jsonb(claim);
  elsif p_phase = 'finish' then
    if exists (select 1 from jsonb_array_elements(op.targets) a where not exists (
      select 1 from public.sleeper_drop_claims c where c.cleanup_id = op.id
        and c.assignment_id = a->>'id' and c.status = 'verified')) then
      raise sqlstate 'PT409' using message = 'Cleanup incomplete; week will not advance';
    end if;
    s := r.state || jsonb_build_object('week', p_week + 1, 'players', '[]'::jsonb,
      'excluded', '[]'::jsonb, 'locked', '[]'::jsonb, 'lastSpin', null,
      'source', 'Awaiting this week''s Sleeper import');
    -- Preserve applied, TE, rosterHistory and every unrelated ledger entry.
    s := jsonb_set(s, '{assignments}', coalesce((select jsonb_agg(
      case when exists (select 1 from jsonb_array_elements(op.targets) t where t->>'id' = a->>'id')
        then jsonb_set(a,'{dropped}','true') else a end order by n)
      from jsonb_array_elements(s->'assignments') with ordinality items(a,n)), '[]'::jsonb));
    update public.rooms set state = s, version = version + 1 where id = p_room_id returning * into r;
    update public.sleeper_cleanups set status = 'completed', completed_at = now(), worker = null, lease_until = null where id = op.id;
    return jsonb_build_object('completed', true, 'room', to_jsonb(r));
  end if;
  raise sqlstate 'PT422' using message = 'Unknown cleanup phase';
end;
$$;

alter function public.commit_room_command(uuid,uuid,integer,jsonb) rename to commit_room_command_before_cleanup;
create function public.commit_room_command(p_room_id uuid,p_user_id uuid,p_expected_version integer,p_new_state jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.rooms%rowtype;
begin
  select * into r from public.rooms where id = p_room_id for update;
  if p_room_id = '69103cd4-0f84-4ce1-b9d1-dfb3096771bc'::uuid and (
    p_new_state->'week' is distinct from r.state->'week' or p_new_state->'season' is distinct from r.state->'season'
    or exists(select 1 from public.sleeper_cleanups where room_id = p_room_id and status = 'active')) then
    raise sqlstate 'PT422' using message = 'Use authenticated Sleeper cleanup to open next week; active cleanup locks room commands';
  end if;
  return public.commit_room_command_before_cleanup(p_room_id,p_user_id,p_expected_version,p_new_state);
end;
$$;

alter function public.claim_sleeper_player(uuid,uuid,text,integer) rename to claim_sleeper_player_before_cleanup;
-- Preserve every add audit across weekly cycles. One assignment cannot be
-- retried, and an uncertain player write blocks all later assignments.
alter table public.sleeper_apply_claims drop constraint sleeper_apply_claims_league_id_player_id_key;
alter table public.sleeper_apply_claims add unique(league_id,player_id,assignment_id);
create unique index sleeper_one_uncertain_add on public.sleeper_apply_claims(league_id,player_id) where status = 'uncertain';
create function public.claim_sleeper_player(p_room_id uuid,p_user_id uuid,p_assignment_id text,p_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.rooms%rowtype; a jsonb; c public.sleeper_apply_claims%rowtype;
begin
  select * into r from public.rooms where id = p_room_id for update;
  if not found then raise sqlstate 'PT404' using message = 'Room not found'; end if;
  if p_user_id is null or (r.owner_id <> p_user_id and not exists(
    select 1 from public.room_commissioners where room_id=p_room_id and user_id=p_user_id
  )) then raise sqlstate 'PT403' using message = 'Commissioner access required'; end if;
  if exists(select 1 from public.sleeper_cleanups where room_id = p_room_id and status = 'active') then
    raise sqlstate 'PT409' using message = 'Weekly cleanup active; adds are disabled';
  end if;
  if p_room_id <> '69103cd4-0f84-4ce1-b9d1-dfb3096771bc'::uuid or r.state->>'leagueId' <> '1389331555339468800'
    or not exists(select 1 from public.sleeper_room_bindings where room_id=p_room_id and league_id=r.state->>'leagueId') then
    raise sqlstate 'PT422' using message = 'Unapproved room binding';
  end if;
  if r.version <> p_version then raise sqlstate 'PT409' using message = 'Room changed; refresh status'; end if;
  select value into strict a from jsonb_array_elements(r.state->'assignments') where value->>'id'=p_assignment_id;
  if a->>'dropped' <> 'false' or a->>'season' <> '2026' or r.state->>'season' <> '2026'
    or a->>'week' <> r.state->>'week' or (r.state->>'week')::integer not between 2 and 18
    or a#>>'{player,position}' not in ('QB','RB','WR') or a#>>'{player,id}' !~ '^[1-9][0-9]{0,9}$'
    or a#>>'{manager,id}' !~ '^[1-9][0-9]{0,3}$' then
    raise sqlstate 'PT422' using message = 'Assignment is not eligible for a current roster add';
  end if;
  if (a->>'id'=r.state#>>'{lastSpin,id}' or a->>'awardedWithSpinId'=r.state#>>'{lastSpin,id}')
    and extract(epoch from clock_timestamp())*1000 < (r.state#>>'{lastSpin,startedAt}')::numeric+5000 then
    raise sqlstate 'PT409' using message = 'Wait for the player wheel reveal';
  end if;
  if exists(select 1 from public.sleeper_apply_claims old
    where old.league_id=r.state->>'leagueId' and old.player_id=a#>>'{player,id}'
      and old.assignment_id<>p_assignment_id and not exists(
        select 1 from public.sleeper_drop_claims d join public.sleeper_cleanups op on op.id=d.cleanup_id
        where d.assignment_id=old.assignment_id and d.player_id=old.player_id and d.status='verified'
          and op.status='completed' and op.room_id=p_room_id)) then
    raise sqlstate 'PT409' using message = 'Previous player award requires verified completed cleanup';
  end if;
  insert into public.sleeper_apply_claims(room_id,league_id,assignment_id,player_id,roster_id,requested_by,assignment)
    values(p_room_id,r.state->>'leagueId',p_assignment_id,a#>>'{player,id}',(a#>>'{manager,id}')::integer,p_user_id,a)
    on conflict do nothing returning * into c;
  if not found then raise sqlstate 'PT409' using message = 'An add was already claimed; verification only, never retry'; end if;
  return to_jsonb(c);
end;
$$;
revoke all on function public.sleeper_cleanup_ready(jsonb) from public,anon,authenticated,service_role;
alter function public.observe_sleeper_players(uuid,uuid,integer,jsonb) rename to observe_sleeper_players_before_cleanup;
create function public.observe_sleeper_players(p_room_id uuid,p_user_id uuid,p_version integer,p_present_ids jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.rooms where id = p_room_id for update;
  if exists(select 1 from public.sleeper_cleanups where room_id = p_room_id and status = 'active') then return; end if;
  perform public.observe_sleeper_players_before_cleanup(p_room_id,p_user_id,p_version,p_present_ids);
end;
$$;
alter function public.verify_sleeper_player(uuid,uuid,text) rename to verify_sleeper_player_before_cleanup;
create function public.verify_sleeper_player(p_claim_id uuid,p_user_id uuid,p_transaction_id text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare room uuid;
begin
  select room_id into room from public.sleeper_apply_claims where id = p_claim_id;
  perform 1 from public.rooms where id = room for update;
  if exists(select 1 from public.sleeper_cleanups where room_id = room and status = 'active') then
    raise sqlstate 'PT409' using message = 'Cleanup active; add verification paused';
  end if;
  perform public.verify_sleeper_player_before_cleanup(p_claim_id,p_user_id,p_transaction_id);
end;
$$;
revoke all on function public.observe_sleeper_players_before_cleanup(uuid,uuid,integer,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.verify_sleeper_player_before_cleanup(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.observe_sleeper_players(uuid,uuid,integer,jsonb) from public,anon,authenticated;
revoke all on function public.verify_sleeper_player(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.observe_sleeper_players(uuid,uuid,integer,jsonb) to service_role;
grant execute on function public.verify_sleeper_player(uuid,uuid,text) to service_role;
revoke all on function public.sleeper_cleanup_step(uuid,uuid,integer,integer,integer,text,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.commit_room_command_before_cleanup(uuid,uuid,integer,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.claim_sleeper_player_before_cleanup(uuid,uuid,text,integer) from public,anon,authenticated,service_role;
revoke all on function public.commit_room_command(uuid,uuid,integer,jsonb) from public,anon,authenticated;
revoke all on function public.claim_sleeper_player(uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.sleeper_cleanup_step(uuid,uuid,integer,integer,integer,text,uuid,text,text,text) to service_role;
grant execute on function public.commit_room_command(uuid,uuid,integer,jsonb) to service_role;
grant execute on function public.claim_sleeper_player(uuid,uuid,text,integer) to service_role;
commit;
