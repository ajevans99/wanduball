-- Apply once through Supabase SQL Editor, or with `supabase db push`.
-- Room game data is PUBLIC, not a confidential UUID capability.
begin;

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  version integer not null default 0 check (version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index rooms_owner_id_idx on public.rooms (owner_id);

create function public.guard_room_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id or new.owner_id is distinct from old.owner_id then
    raise exception 'Room identity and ownership are immutable';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'Room updates must increment the version by exactly one';
  end if;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end;
$$;

create trigger guard_room_update
before update on public.rooms
for each row execute function public.guard_room_update();

alter table public.rooms enable row level security;

revoke all on table public.rooms from public, anon, authenticated;
grant select on table public.rooms to anon, authenticated;
grant select, insert, update, delete on table public.rooms to service_role;
revoke all on function public.guard_room_update() from public;

-- Required for anonymous postgres_changes subscriptions and spectator reads.
-- This deliberately permits listing ALL game states, not just known room IDs.
create policy "Room game data is public"
on public.rooms for select
to anon, authenticated
using (true);

-- No client INSERT/UPDATE/DELETE policies. Only the authenticated server API
-- uses service_role, after checking the immutable owner's auth.users ID.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rooms'
  ) then
    alter publication supabase_realtime add table public.rooms;
  end if;
end;
$$;

commit;
