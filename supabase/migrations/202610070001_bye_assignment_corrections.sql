begin;

alter function public.commit_room_command(uuid,uuid,integer,jsonb) rename to commit_room_command_before_bye_corrections;
create function public.commit_room_command(p_room_id uuid,p_user_id uuid,p_expected_version integer,p_new_state jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.rooms%rowtype; assignments jsonb;
begin
  select * into r from public.rooms where id = p_room_id for update;
  -- Older clients strip unknown metadata. Restore correction links, but never
  -- permit removal or editing of the superseded award itself.
  if exists (
    select 1 from jsonb_array_elements(r.state->'assignments') a
    left join jsonb_array_elements(p_new_state->'assignments') n on n->>'id' = a->>'id'
    where (a ? 'replacedByAssignmentId' or a ? 'replacesAssignmentId') and (
      n is null
      or (a ? 'replacedByAssignmentId' and
        (n - 'replacedByAssignmentId' - 'replacedAt') is distinct from
        (a - 'replacedByAssignmentId' - 'replacedAt'))
      or (n ? 'replacedByAssignmentId' and n->'replacedByAssignmentId' is distinct from a->'replacedByAssignmentId')
      or (n ? 'replacesAssignmentId' and n->'replacesAssignmentId' is distinct from a->'replacesAssignmentId')
    )
  ) then raise sqlstate 'PT422' using message = 'Bye correction history and links cannot be changed'; end if;
  select coalesce(jsonb_agg(case
    when a ? 'replacedByAssignmentId' then a
    when a ? 'replacesAssignmentId' then n || jsonb_build_object('replacesAssignmentId', a->'replacesAssignmentId')
    else n end order by ordinal), '[]'::jsonb) into assignments
    from jsonb_array_elements(p_new_state->'assignments') with ordinality items(n,ordinal)
    left join jsonb_array_elements(r.state->'assignments') a on a->>'id' = n->>'id';
  p_new_state = jsonb_set(p_new_state, '{assignments}', assignments);
  return public.commit_room_command_before_bye_corrections(p_room_id,p_user_id,p_expected_version,p_new_state);
end;
$$;
revoke all on function public.commit_room_command_before_bye_corrections(uuid,uuid,integer,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.commit_room_command(uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.commit_room_command(uuid,uuid,integer,jsonb) to service_role;

-- Retain both awards as cleanup targets, so an original accidentally re-added
-- after correction is still reconciled. Only the replacement needs application.
create or replace function public.sleeper_cleanup_step(
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
      and not (a ? 'replacedByAssignmentId')
      and (a ? 'replacesAssignmentId' or a->>'id' = r.state#>>'{lastSpin,id}' or a->>'awardedWithSpinId' = r.state#>>'{lastSpin,id}')
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

commit;
