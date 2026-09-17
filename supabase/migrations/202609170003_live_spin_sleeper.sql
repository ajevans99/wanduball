begin;

-- Binding remains to one league/season, but follows legitimate live week advancement.
create or replace function public.claim_sleeper_player(p_room_id uuid, p_user_id uuid, p_assignment_id text, p_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.rooms%rowtype; b public.sleeper_room_bindings%rowtype;
  a jsonb; c public.sleeper_apply_claims%rowtype;
begin
  select * into r from public.rooms where id = p_room_id for update;
  if not found then raise sqlstate 'PT404' using message = 'Room not found'; end if;
  if p_user_id is null or (r.owner_id <> p_user_id and not exists (
    select 1 from public.room_commissioners where room_id = p_room_id and user_id = p_user_id
  )) then raise sqlstate 'PT403' using message = 'Commissioner access required'; end if;
  select * into b from public.sleeper_room_bindings where room_id = p_room_id;
  if not found or p_room_id <> '69103cd4-0f84-4ce1-b9d1-dfb3096771bc'::uuid
    or b.league_id <> '1389331555339468800' or r.state->>'leagueId' <> b.league_id then
    raise sqlstate 'PT422' using message = 'Room is not bound to this league';
  end if;
  if r.version <> p_version then raise sqlstate 'PT409' using message = 'Room changed; refresh status'; end if;
  select value into strict a from jsonb_array_elements(r.state->'assignments') where value->>'id' = p_assignment_id;
  if a->>'dropped' <> 'false' or a->>'season' <> '2026' or r.state->>'season' <> '2026'
    or a->>'week' <> r.state->>'week' or (r.state->>'week')::integer not between 2 and 18
    or a#>>'{player,position}' not in ('QB', 'RB', 'WR')
    or a#>>'{player,id}' !~ '^[1-9][0-9]{0,9}$'
    or a#>>'{manager,id}' !~ '^[1-9][0-9]{0,3}$' then
    raise sqlstate 'PT422' using message = 'Assignment is not eligible for a current roster add';
  end if;
  if (a->>'id' = r.state#>>'{lastSpin,id}' or a->>'awardedWithSpinId' = r.state#>>'{lastSpin,id}')
    and extract(epoch from clock_timestamp()) * 1000 < (r.state#>>'{lastSpin,startedAt}')::numeric + 5000 then
    raise sqlstate 'PT409' using message = 'Wait for the player wheel reveal';
  end if;
  insert into public.sleeper_apply_claims(room_id, league_id, assignment_id, player_id, roster_id, requested_by, assignment)
    values (p_room_id, b.league_id, p_assignment_id, a#>>'{player,id}', (a#>>'{manager,id}')::integer, p_user_id, a)
    on conflict (league_id, player_id) do nothing returning * into c;
  if not found then raise sqlstate 'PT409' using message = 'An add was already claimed; verification only, never retry'; end if;
  return to_jsonb(c);
end;
$$;

-- A second commissioner tab must not race a pending or uncertain external add.
alter function public.commit_room_command(uuid, uuid, integer, jsonb) rename to commit_room_command_before_live_auto;
revoke all on function public.commit_room_command_before_live_auto(uuid, uuid, integer, jsonb) from public, anon, authenticated, service_role;
create function public.commit_room_command(p_room_id uuid, p_user_id uuid, p_expected_version integer, p_new_state jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.rooms%rowtype;
begin
  select * into r from public.rooms where id = p_room_id for update;
  if p_room_id = '69103cd4-0f84-4ce1-b9d1-dfb3096771bc'::uuid
    and (p_new_state->'lastSpin' is distinct from r.state->'lastSpin'
      or p_new_state->'week' is distinct from r.state->'week'
      or p_new_state->'season' is distinct from r.state->'season') then
    if exists (select 1 from public.sleeper_apply_claims where room_id = p_room_id and status = 'uncertain')
      or (r.state->>'season' = '2026' and (r.state->>'week')::integer >= 3 and exists (
        select 1 from jsonb_array_elements(r.state->'assignments') a
        where a->>'season' = r.state->>'season' and a->>'week' = r.state->>'week'
          and (a->>'id' = r.state#>>'{lastSpin,id}' or a->>'awardedWithSpinId' = r.state#>>'{lastSpin,id}')
          and a->>'applied' <> 'true'
      )) then
      raise sqlstate 'PT409' using message = 'Verify pending Sleeper adds before another spin or week advancement';
    end if;
  end if;
  return public.commit_room_command_before_live_auto(p_room_id, p_user_id, p_expected_version, p_new_state);
end;
$$;
revoke all on function public.commit_room_command(uuid, uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.commit_room_command(uuid, uuid, integer, jsonb) to service_role;
commit;
