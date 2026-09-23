-- Scoring is managed manually and must not block roster cleanup.
create or replace function public.sleeper_cleanup_ready(s jsonb) returns void
language plpgsql set search_path = '' as $$
begin
  if s->>'season' <> '2026' or (s->>'week')::integer not between 2 and 17 then
    raise sqlstate 'PT422' using message = 'Cleanup requires an open 2026 week before week 18';
  end if;
  if s#>>'{pending,duration}' is not null or s#>>'{pending,ruleId}' is not null then
    raise sqlstate 'PT422' using message = 'Finish the current chaos round first';
  end if;
  if extract(epoch from clock_timestamp()) * 1000 < coalesce((s#>>'{lastSpin,startedAt}')::numeric, 0) + 5000 then
    raise sqlstate 'PT409' using message = 'Wait for the wheel reveal';
  end if;
end;
$$;
