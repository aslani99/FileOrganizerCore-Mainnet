begin;
-- Invoker-security RPCs: callable only by the service role, never by browser users.
grant delete on public.discount_codes to service_role;
create or replace function public.admin_delete_discount(p_admin uuid, p_code text) returns jsonb
language plpgsql set search_path = public as $$
declare v_role text; v_before jsonb;
begin
  select role into v_role from public.admin_users where user_id=p_admin and is_active for share;
  if v_role is null or v_role not in ('owner','admin') then raise exception 'forbidden' using errcode='42501'; end if;
  select to_jsonb(d) into v_before from public.discount_codes d where code=p_code for update;
  if not found then raise exception 'discount_not_found' using errcode='P0002'; end if;
  delete from public.discount_codes where code=p_code;
  insert into public.admin_audit_logs(admin_user_id,action,target_type,target_id,metadata)
    values(p_admin,'delete_discount','discount',p_code,jsonb_build_object('before',v_before,'after',null));
  return jsonb_build_object('deleted',true);
end $$;
revoke all on function public.admin_delete_discount(uuid,text) from public,anon,authenticated;
grant execute on function public.admin_delete_discount(uuid,text) to service_role;

alter table public.pi_rate add column if not exists source_updated_at timestamptz;
grant insert,update on public.pi_rate to service_role;
create or replace function public.apply_pi_rate(p_usd numeric, p_observed timestamptz) returns jsonb
language plpgsql set search_path = public as $$
declare previous timestamptz;
begin
  if p_usd is null or p_usd <= 0 or p_usd::text in ('NaN','Infinity','-Infinity') or
     p_observed is null or p_observed < now()-interval '15 minutes' or p_observed > now()+interval '1 minute' then
    raise exception 'invalid_or_stale_rate' using errcode='22023';
  end if;
  -- Serialize updater transactions, including the first insert if the row is missing.
  perform pg_advisory_xact_lock(6221022);
  select source_updated_at into previous from public.pi_rate where id=1 for update;
  if previous is not null and p_observed < previous then
    return jsonb_build_object('updated',false,'reason','older_provider_snapshot');
  end if;
  insert into public.pi_rate(id,usd_rate,source,updated_at,source_updated_at)
    values(1,p_usd,'coingecko',p_observed,p_observed)
    on conflict(id) do update set usd_rate=excluded.usd_rate,source=excluded.source,
      updated_at=excluded.updated_at,source_updated_at=excluded.source_updated_at;
  -- All plan amounts and the displayed rate commit together; payment snapshots stay unchanged.
  update public.plans set pi_amount=round(price_usd/p_usd,7), pi_rate_updated_at=p_observed,pi_rate_source='coingecko'
    where plan_id in ('pro','max');
  return jsonb_build_object('updated',true,'usdRate',p_usd,'updatedAt',p_observed);
end $$;
revoke all on function public.apply_pi_rate(numeric,timestamptz) from public,anon,authenticated;
grant execute on function public.apply_pi_rate(numeric,timestamptz) to service_role;
commit;
