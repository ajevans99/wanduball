begin;

-- Membership is private and is never published through Realtime.
create table public.room_commissioners (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (room_id, user_id)
);
create index room_commissioners_user_id_idx on public.room_commissioners (user_id);
alter table public.room_commissioners enable row level security;
revoke all on table public.room_commissioners from public, anon, authenticated, service_role;
grant select on table public.room_commissioners to service_role;

create function public.room_commissioner_access(p_room_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_is_owner boolean;
  v_members jsonb := '[]'::jsonb;
begin
  -- Management and command commits take FOR UPDATE on this same row.
  select owner_id into v_owner_id from public.rooms where id = p_room_id for share;
  if not found then
    raise sqlstate 'PT404' using message = 'Room not found';
  end if;
  v_is_owner := coalesce(v_owner_id = p_user_id, false);
  if v_is_owner then
    select coalesce(jsonb_agg(jsonb_build_object('userId', u.id, 'email', u.email) order by u.email, u.id), '[]'::jsonb)
      into v_members
      from public.room_commissioners c
      join auth.users u on u.id = c.user_id
      where c.room_id = p_room_id;
  end if;
  return jsonb_build_object(
    'canEdit', v_is_owner or exists (
      select 1 from public.room_commissioners where room_id = p_room_id and user_id = p_user_id
    ),
    'isOwner', v_is_owner,
    'commissioners', v_members
  );
end;
$$;

create function public.manage_room_commissioner(
  p_room_id uuid,
  p_user_id uuid,
  p_action text,
  p_email text default null,
  p_member_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_member_id uuid;
  v_confirmed_at timestamptz;
  v_email text := lower(btrim(p_email));
begin
  select owner_id into v_owner_id from public.rooms where id = p_room_id for update;
  if not found then
    raise sqlstate 'PT404' using message = 'Room not found';
  end if;
  if p_user_id is null or v_owner_id <> p_user_id then
    raise sqlstate 'PT403' using message = 'Only the creator may manage access';
  end if;

  if p_action = 'add' then
    if v_email is null or length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
      or p_member_user_id is not null then
      raise sqlstate 'PT422' using message = 'Invalid email';
    end if;
    -- Exact normalized lookup, never an Auth admin list or invite operation.
    begin
      select id, email_confirmed_at into strict v_member_id, v_confirmed_at
        from auth.users where lower(email) = v_email;
    exception
      when no_data_found then
        raise sqlstate 'PT410' using message = 'Account not found';
      when too_many_rows then
        raise sqlstate 'PT422' using message = 'Account email is ambiguous';
    end;
    if v_confirmed_at is null then
      raise sqlstate 'PT422' using message = 'Account email is not confirmed';
    end if;
    if v_member_id = v_owner_id then
      raise sqlstate 'PT400' using message = 'Creator already has permanent access';
    end if;
    insert into public.room_commissioners (room_id, user_id) values (p_room_id, v_member_id)
      on conflict (room_id, user_id) do nothing;
  elsif p_action = 'remove' then
    if p_member_user_id = v_owner_id then
      raise sqlstate 'PT400' using message = 'Creator cannot be removed';
    end if;
    if p_member_user_id is null or p_email is not null then
      raise sqlstate 'PT422' using message = 'Invalid member';
    end if;
    delete from public.room_commissioners where room_id = p_room_id and user_id = p_member_user_id;
  else
    raise sqlstate 'PT422' using message = 'Invalid action';
  end if;
  return public.room_commissioner_access(p_room_id, p_user_id);
end;
$$;

create function public.commit_room_command(
  p_room_id uuid,
  p_user_id uuid,
  p_expected_version integer,
  p_new_state jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms%rowtype;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise sqlstate 'PT404' using message = 'Room not found';
  end if;
  if p_user_id is null or (
    v_room.owner_id <> p_user_id and not exists (
      select 1 from public.room_commissioners where room_id = p_room_id and user_id = p_user_id
    )
  ) then
    raise sqlstate 'PT403' using message = 'Commissioner access required';
  end if;
  if p_expected_version is null or v_room.version <> p_expected_version then
    raise sqlstate 'PT409' using message = 'Room version changed';
  end if;
  if p_new_state is null or jsonb_typeof(p_new_state) <> 'object' then
    raise sqlstate 'PT422' using message = 'Invalid room state';
  end if;
  update public.rooms set state = p_new_state, version = version + 1
    where id = p_room_id returning * into v_room;
  return jsonb_build_object('state', v_room.state, 'version', v_room.version);
end;
$$;

-- Only service-role RPCs can mutate membership. Preserve the existing room
-- UPDATE grant for owner-only servers during rollout; new servers use the RPC.
-- The existing immutable-owner/version trigger is deliberately left intact.
revoke all on function public.room_commissioner_access(uuid, uuid) from public, anon, authenticated;
revoke all on function public.manage_room_commissioner(uuid, uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.commit_room_command(uuid, uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.room_commissioner_access(uuid, uuid) to service_role;
grant execute on function public.manage_room_commissioner(uuid, uuid, text, text, uuid) to service_role;
grant execute on function public.commit_room_command(uuid, uuid, integer, jsonb) to service_role;

commit;
