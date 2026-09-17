begin;

-- Old deployed clients do not know the new read-only ledger field. Preserve it
-- in the authoritative commit so an unrelated command cannot erase provenance.
create or replace function public.commit_room_command(p_room_id uuid, p_user_id uuid, p_expected_version integer, p_new_state jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.rooms%rowtype;
begin
  select * into r from public.rooms where id = p_room_id for update;
  if r.state ? 'rosterHistory' then
    p_new_state = jsonb_set(p_new_state, '{rosterHistory}', r.state->'rosterHistory');
  end if;
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

commit;
