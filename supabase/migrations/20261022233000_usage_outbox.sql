-- Client-created events contain only copied-byte deltas. Identity always comes from auth.uid().
create table if not exists public.usage_events (
 user_id uuid not null references auth.users(id) on delete cascade,
 event_id uuid not null,
 bytes bigint not null check(bytes>0),
 received_at timestamptz not null default now(),
 primary key(user_id,event_id)
);
alter table public.usage_events enable row level security;
revoke all on public.usage_events from public,anon,authenticated;
grant select on public.usage_events to service_role;
create or replace function public.report_usage_batch(p_events jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 uid uuid:=auth.uid(); e jsonb; eid uuid; amount bigint; existing bigint; added bigint:=0; total bigint; inserted integer;
begin
 if uid is null then raise exception 'authentication_required' using errcode='42501'; end if;
 if p_events is null or jsonb_typeof(p_events)<>'array' then raise exception 'invalid_usage_batch'; end if;
 if jsonb_array_length(p_events)<1 or jsonb_array_length(p_events)>100 then raise exception 'invalid_usage_batch'; end if;
 -- Profile lock serializes concurrent batches for the same user, including duplicate retries.
 select bytes_organized_total into total from public.profiles where id=uid for update;
 if not found then raise exception 'profile_not_found'; end if;
 for e in select value from jsonb_array_elements(p_events) loop
  if jsonb_typeof(e)<>'object' or jsonb_typeof(e->'bytes')<>'number' or
     (e->>'bytes') !~ '^[1-9][0-9]*$' or e->>'event_id' is null then raise exception 'invalid_usage_event'; end if;
  eid:=(e->>'event_id')::uuid; amount:=(e->>'bytes')::bigint;
  if eid='00000000-0000-0000-0000-000000000000'::uuid then raise exception 'invalid_usage_event'; end if;
  insert into public.usage_events(user_id,event_id,bytes) values(uid,eid,amount) on conflict do nothing;
  get diagnostics inserted = row_count;
  if inserted=1 then added:=added+amount;
  else
   select bytes into existing from public.usage_events where user_id=uid and event_id=eid;
   if existing<>amount then raise exception 'usage_event_conflict'; end if;
  end if;
 end loop;
 update public.profiles set bytes_organized_total=bytes_organized_total+added where id=uid returning bytes_organized_total into total;
 return jsonb_build_object('ok',true,'count',jsonb_array_length(p_events),'total_bytes',total::text);
end $$;
revoke all on function public.report_usage_batch(jsonb) from public,anon;
grant execute on function public.report_usage_batch(jsonb) to authenticated;
