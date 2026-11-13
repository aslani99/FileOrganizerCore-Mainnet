-- Purchased days are elapsed 24-hour periods, independent of display calendar/DST.
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
  v_expiry := (case when v_active then p.plan_expires_at else now() end) + s.purchased_duration_days * interval '24 hours';
  v_plan := case when v_active and p.plan = 'max' then 'max'::public.plan_type else s.requested_plan end;
  update public.profiles set plan=v_plan, plan_expires_at=v_expiry, last_expired_plan=null where id=v_user;
  update public.payment_sessions set subscription_synced=true where id=p_session_id;
  return jsonb_build_object('ok',true,'applied',true,'newPlan',v_plan,'expiresAt',v_expiry);
end $$;

revoke all on function public.activate_payment_subscription(uuid) from public,anon,authenticated;
grant execute on function public.activate_payment_subscription(uuid) to service_role;
