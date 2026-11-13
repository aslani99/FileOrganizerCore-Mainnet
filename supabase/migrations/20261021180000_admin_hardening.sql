-- Additive migration. Run ONCE after the existing initial migration.
-- Never rerun schema.sql: its historical backfill marks all completed payments synced.
begin;

revoke all on public.admin_users, public.admin_audit_logs from public, anon, authenticated;
grant select, insert, update, delete on public.admin_users to service_role;
grant select, insert on public.admin_audit_logs to service_role;
grant usage, select on sequence public.admin_audit_logs_id_seq to service_role;
grant select, update on public.plans to service_role;
grant select, insert, update on public.discount_codes to service_role;

alter table public.payment_sessions add column if not exists purchased_duration_days integer
  check (purchased_duration_days > 0);
-- Historical durations are intentionally NOT guessed from today's plans.
create or replace function public.capture_payment_duration() returns trigger
language plpgsql set search_path = public as $$
begin
  select duration_days into new.purchased_duration_days from public.plans
    where plan_id = new.requested_plan::text;
  if new.requested_plan::text not in ('pro','max') or new.purchased_duration_days is null or new.purchased_duration_days <= 0 then
    raise exception 'invalid_plan_duration' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists capture_payment_duration on public.payment_sessions;
create trigger capture_payment_duration before insert on public.payment_sessions
for each row execute function public.capture_payment_duration();

-- All activation callers use this one transaction: profile + session flag.
-- Lock profile first so concurrent different payments for the same user serialize.
create or replace function public.activate_payment_subscription(p_session_id uuid) returns jsonb
language plpgsql set search_path = public as $$
declare s public.payment_sessions%rowtype; p public.profiles%rowtype; v_user uuid;
  v_expiry timestamptz; v_plan public.plan_type; v_active boolean;
begin
  select user_id into v_user from public.payment_sessions where id = p_session_id;
  if not found then raise exception 'session_not_found' using errcode = 'P0002'; end if;
  select * into p from public.profiles where id = v_user for update;
  if not found then raise exception 'profile_not_found' using errcode = 'P0002'; end if;
  select * into s from public.payment_sessions where id = p_session_id for update;
  if s.status <> 'completed' then raise exception 'payment_not_completed' using errcode = '22023'; end if;
  if s.subscription_synced then
    return jsonb_build_object('ok',true,'applied',false,'newPlan',p.plan,'expiresAt',p.plan_expires_at);
  end if;
  if s.purchased_duration_days is null then raise exception 'legacy_duration_required'; end if;
  if s.requested_plan::text not in ('pro','max') then raise exception 'invalid_plan' using errcode = '22023'; end if;
  v_active := p.plan::text in ('pro','max') and p.plan_expires_at > now();
  v_expiry := (case when v_active then p.plan_expires_at else now() end) + s.purchased_duration_days * interval '1 day';
  v_plan := case when v_active and p.plan = 'max' then 'max'::public.plan_type else s.requested_plan end;
  update public.profiles set plan=v_plan, plan_expires_at=v_expiry, last_expired_plan=null where id=v_user;
  update public.payment_sessions set subscription_synced=true where id=p_session_id;
  return jsonb_build_object('ok',true,'applied',true,'newPlan',v_plan,'expiresAt',v_expiry);
end $$;

create or replace function public.admin_overview_stats() returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'totalUsers',(select count(*) from public.profiles),
    'paidUsers',(select count(*) from public.profiles where plan in ('pro','max') and plan_expires_at > now()),
    'completedPayments',(select count(*) from public.payment_sessions where status='completed'),
    'piVolume',(select coalesce(sum(amount_pi),0) from public.payment_sessions where status='completed'));
$$;
create or replace function public.admin_user_payment_stats(p_ids uuid[])
returns table(user_id uuid, completed_payment_count bigint, unsynced_completed_count bigint)
language sql stable set search_path = public as $$
  select s.user_id, count(*), count(*) filter (where not s.subscription_synced)
  from public.payment_sessions s where s.user_id=any(p_ids) and s.status='completed' group by s.user_id;
$$;

-- Only service_role can call this RPC. p_admin comes from verified getUser(), never request JSON.
-- Audit insert failure rolls back the associated mutation.
create or replace function public.admin_mutate(p_admin uuid, p_action text, p_body jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare v_role text; v_before jsonb; v_after jsonb; v_target text; v_type text;
  v_session record; v_result jsonb; v_count integer := 0; v_user uuid; v_rate public.pi_rate%rowtype;
begin
  select role into v_role from public.admin_users where user_id=p_admin and is_active for share;
  if v_role is null or v_role not in ('owner','admin') then raise exception 'forbidden' using errcode='42501'; end if;
  if p_action='update_plan' then
    v_target := p_body->>'plan_id'; v_type := 'plan';
    select to_jsonb(p) into v_before from public.plans p where plan_id=v_target for update;
    if not found then raise exception 'plan_not_found' using errcode='P0002'; end if;
    if coalesce(length(trim(p_body->>'name')),0)=0 or (p_body->>'duration_days')::int not between 1 and 3650
      or (p_body->>'price_usd')::numeric < 0 then raise exception 'invalid_plan' using errcode='22023'; end if;
    if (v_before->>'price_usd')::numeric is distinct from (p_body->>'price_usd')::numeric then
      select * into v_rate from public.pi_rate where id=1;
      if v_rate.usd_rate is null or v_rate.usd_rate <= 0 or v_rate.updated_at < now()-interval '30 minutes' then
        raise exception 'rate_stale';
      end if;
    end if;
    update public.plans set name=p_body->>'name', price_usd=(p_body->>'price_usd')::numeric,
      duration_days=(p_body->>'duration_days')::int, is_active=(p_body->>'is_active')::boolean,
      pi_amount=case when price_usd is distinct from (p_body->>'price_usd')::numeric then round((p_body->>'price_usd')::numeric/v_rate.usd_rate,7) else pi_amount end,
      pi_rate_updated_at=case when price_usd is distinct from (p_body->>'price_usd')::numeric then v_rate.updated_at else pi_rate_updated_at end,
      pi_rate_source=case when price_usd is distinct from (p_body->>'price_usd')::numeric then v_rate.source else pi_rate_source end
      where plan_id=v_target returning to_jsonb(plans.*) into v_after;
  elsif p_action='upsert_discount' then
    -- Create only: duplicate codes must never silently overwrite an existing promotion.
    v_target := p_body->>'code'; v_type := 'discount';
    insert into public.discount_codes(code,discount_percent,is_active,max_uses,expires_at,applies_to_plan)
      values(v_target,(p_body->>'discount_percent')::numeric,(p_body->>'is_active')::boolean,
        (p_body->>'max_uses')::int,(p_body->>'expires_at')::timestamptz,p_body->>'applies_to_plan')
      returning to_jsonb(discount_codes.*) into v_after;
  elsif p_action='update_discount' then
    v_target := p_body->>'code'; v_type := 'discount';
    select to_jsonb(d) into v_before from public.discount_codes d where code=v_target for update;
    if not found then raise exception 'discount_not_found' using errcode='P0002'; end if;
    update public.discount_codes set is_active=(p_body->>'is_active')::boolean where code=v_target returning to_jsonb(discount_codes.*) into v_after;
  elsif p_action='reconcile_user' then
    v_user := (p_body->>'user_id')::uuid; v_target := v_user::text; v_type := 'user';
    select jsonb_build_object('plan',plan,'plan_expires_at',plan_expires_at) into v_before
      from public.profiles where id=v_user for update;
    if not found then raise exception 'profile_not_found' using errcode='P0002'; end if;
    for v_session in select id from public.payment_sessions where user_id=v_user and status='completed' and not subscription_synced
      order by created_at,id limit 50 loop
      v_result := public.activate_payment_subscription(v_session.id);
      if (v_result->>'applied')::boolean then v_count := v_count+1; end if;
    end loop;
    select jsonb_build_object('plan',plan,'plan_expires_at',plan_expires_at) into v_after from public.profiles where id=v_user;
  else raise exception 'unknown_action' using errcode='22023';
  end if;
  insert into public.admin_audit_logs(admin_user_id,action,target_type,target_id,metadata)
    values(p_admin,p_action,v_type,v_target,jsonb_build_object('before',v_before,'after',v_after,'repaired',v_count));
  return jsonb_build_object('item',v_after,'before',v_before,'after',v_after,'repaired',v_count,'reconciled',v_count>0);
end $$;

revoke all on function public.capture_payment_duration() from public, anon, authenticated;
revoke all on function public.activate_payment_subscription(uuid) from public, anon, authenticated;
revoke all on function public.admin_overview_stats() from public, anon, authenticated;
revoke all on function public.admin_user_payment_stats(uuid[]) from public, anon, authenticated;
revoke all on function public.admin_mutate(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.activate_payment_subscription(uuid), public.admin_overview_stats(),
  public.admin_user_payment_stats(uuid[]), public.admin_mutate(uuid,text,jsonb) to service_role;
create index if not exists admin_payment_unsynced_idx on public.payment_sessions(user_id,created_at,id)
  where status='completed' and not subscription_synced;
commit;
