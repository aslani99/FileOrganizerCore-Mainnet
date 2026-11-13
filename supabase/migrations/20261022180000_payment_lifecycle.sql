begin;
-- Fail safely if historical duplicates need manual review; never delete payment history.
create unique index if not exists payment_unique_pi_id on public.payment_sessions(pi_payment_id) where pi_payment_id is not null;
create unique index if not exists payment_unique_tx on public.payment_sessions(tx_id) where tx_id is not null;
alter table public.payment_sessions add column if not exists original_amount_pi numeric;

create or replace function public.create_checkout_session(p_user uuid,p_plan text,p_discount text default null) returns jsonb
language plpgsql set search_path=public as $$
declare p public.plans%rowtype; d public.discount_codes%rowtype; s public.payment_sessions%rowtype;
 r public.pi_rate%rowtype; base numeric; amount numeric; reserved integer; discount text := nullif(trim(p_discount),'');
begin
 if p_plan not in ('pro','max') or p_plan is null then raise exception 'invalid_plan' using errcode='22023'; end if;
 -- Serialize retries from the same desktop account.
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,55));
 if not exists(select 1 from public.profiles where id=p_user) then raise exception 'profile_not_found' using errcode='P0002'; end if;
 select * into s from public.payment_sessions where user_id=p_user and requested_plan::text=p_plan
   and status in ('pending','approved') and created_at>now()-interval '30 minutes'
   and coalesce(discount_code,'')=coalesce(discount,'') order by created_at desc limit 1;
 if found then return to_jsonb(s); end if;
 if (select count(*) from public.payment_sessions where user_id=p_user and created_at>now()-interval '30 minutes') >= 10 then
   raise exception 'too_many_sessions' using errcode='22023'; end if;
 select * into r from public.pi_rate where id=1 for share;
 if not found or r.usd_rate is null or r.usd_rate<=0 or r.usd_rate::text in ('NaN','Infinity','-Infinity')
   or r.updated_at is null or r.updated_at<now()-interval '30 minutes' or r.updated_at>now()+interval '1 minute' then
   raise exception 'rate_stale' using errcode='22023'; end if;
 select * into p from public.plans where plan_id=p_plan and is_active for share;
 if not found or p.price_usd is null or p.price_usd<=0 or p.price_usd::text in ('NaN','Infinity','-Infinity') then raise exception 'invalid_plan' using errcode='22023'; end if;
 base:=round(p.price_usd/r.usd_rate,7); amount:=base;
 if discount is not null then
   select * into d from public.discount_codes where code=discount for update;
   if not found or not d.is_active or d.expires_at<=now() or (d.applies_to_plan is not null and d.applies_to_plan<>p_plan) then
     raise exception 'invalid_discount' using errcode='22023'; end if;
   -- Bound capacity using completed count plus unpaid reservations. Linked payments keep
   -- their reservation until Pi confirms cancellation, even after the local link TTL.
   select count(*) into reserved from public.payment_sessions where discount_code=d.code
     and status in ('pending','approved') and (pi_payment_id is not null or created_at>now()-interval '30 minutes');
   if d.max_uses is not null and d.used_count+reserved>=d.max_uses then raise exception 'discount_exhausted' using errcode='22023'; end if;
   amount:=round(base*(1-d.discount_percent/100),7);
 end if;
 -- Zero-value purchases need a separate redemption flow, never a fake Pi transaction.
 if amount<=0 then raise exception 'zero_amount_not_supported' using errcode='22023'; end if;
 insert into public.payment_sessions(user_id,requested_plan,amount_pi,original_amount_pi,discount_code,discount_percent)
 values(p_user,p_plan::public.plan_type,amount,base,d.code,d.discount_percent) returning * into s;
 return to_jsonb(s);
end $$;

create or replace function public.transition_pi_payment(p_token text,p_payment text,p_uid text,p_action text,p_tx text default null) returns jsonb
language plpgsql set search_path=public as $$
declare s public.payment_sessions%rowtype;
begin
 select * into s from public.payment_sessions where token=p_token for update;
 if not found then raise exception 'session_not_found' using errcode='P0002'; end if;
 if p_payment is null or p_payment='' or p_uid is null or p_uid='' then raise exception 'missing_identity' using errcode='22023'; end if;
 if (s.pi_payment_id is not null and s.pi_payment_id<>p_payment) or (s.pi_user_uid is not null and s.pi_user_uid<>p_uid) then
   raise exception 'payment_identity_conflict' using errcode='23505'; end if;
 if p_action='complete' then
   if p_tx is null or p_tx='' then raise exception 'missing_tx' using errcode='22023'; end if;
   if s.status='completed' then
     if s.tx_id is distinct from p_tx then raise exception 'tx_conflict' using errcode='23505'; end if;
     return to_jsonb(s);
   end if;
   -- Only the service-role handler may call this after Pi proves the transaction.
   update public.payment_sessions set status='completed',pi_payment_id=p_payment,pi_user_uid=p_uid,tx_id=p_tx where id=s.id returning * into s;
   update public.discount_codes set used_count=used_count+1 where code=s.discount_code;
 elsif p_action='cancel' then
   if s.status<>'completed' then
     update public.payment_sessions set status='cancelled',pi_payment_id=p_payment,pi_user_uid=p_uid where id=s.id returning * into s;
   end if;
 elsif p_action in ('bind','approve') then
   if s.status='completed' then return to_jsonb(s); end if;
   if s.status not in ('pending','approved') then raise exception 'session_closed' using errcode='22023'; end if;
   update public.payment_sessions set pi_payment_id=p_payment,pi_user_uid=p_uid,
     status=case when p_action='approve' then 'approved' else status end where id=s.id returning * into s;
 else raise exception 'invalid_action' using errcode='22023'; end if;
 return to_jsonb(s);
end $$;
revoke all on function public.create_checkout_session(uuid,text,text), public.transition_pi_payment(text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.create_checkout_session(uuid,text,text), public.transition_pi_payment(text,text,text,text,text) to service_role;
commit;
