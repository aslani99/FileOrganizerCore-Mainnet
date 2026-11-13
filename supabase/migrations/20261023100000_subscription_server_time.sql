-- Authenticated snapshot: expiry and server time are read from the same database.
create or replace function public.get_subscription_snapshot()
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.profiles;
begin
 if auth.uid() is null then raise exception 'authentication_required' using errcode='42501'; end if;
 p := public.refresh_subscription();
 if p.id is null then raise exception 'profile_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('server_now',clock_timestamp(),'profile',to_jsonb(p));
end $$;
revoke all on function public.get_subscription_snapshot() from public,anon;
grant execute on function public.get_subscription_snapshot() to authenticated;
