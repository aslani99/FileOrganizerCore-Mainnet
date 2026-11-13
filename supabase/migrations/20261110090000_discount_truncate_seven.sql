BEGIN;
-- New unbound purchases truncate discounted amounts to 7 decimal places.
-- Already bound Pi payments keep their agreed amounts.
create or replace function public.create_quoted_checkout_session(p_user uuid,p_plan text,p_quote uuid,p_discount text default null) returns jsonb
language plpgsql set search_path=public as $$
declare p public.plans%rowtype; d public.discount_codes%rowtype; s public.payment_sessions%rowtype;
 w public.checkout_price_windows%rowtype; quoted jsonb; previous public.payment_sessions%rowtype; r public.pi_rate%rowtype; base numeric; amount numeric; reserved integer; discount text := nullif(trim(p_discount),'');
begin
 if p_plan not in ('pro','max') or p_plan is null then raise exception 'invalid_plan' using errcode='22023'; end if;
 -- Serialize retries from the same desktop account.
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,55));
 if not exists(select 1 from public.profiles where id=p_user) then raise exception 'profile_not_found' using errcode='P0002'; end if;
 -- Never replace or reprice a payment already bound to Pi, even after its quote expires.
 select * into s from public.payment_sessions where user_id=p_user and requested_plan::text=p_plan
   and status in ('pending','approved') and pi_payment_id is not null
   order by created_at asc limit 1;
 if found then return to_jsonb(s) || jsonb_build_object('resumingLinkedPayment',true); end if;
 select * into w from public.checkout_price_windows where id=p_quote;
 if not found or w.expires_at<=clock_timestamp() or w.starts_at>clock_timestamp() then
   raise exception 'quote_expired' using errcode='22023'; end if;
 select value into quoted from jsonb_array_elements(w.plans) where value->>'plan_id'=p_plan;
 if quoted is null then raise exception 'invalid_plan' using errcode='22023'; end if;
 base:=(quoted->>'pi_amount')::numeric;
 if base is null or base<=0 or base::text in ('NaN','Infinity','-Infinity') then
   raise exception 'invalid_plan' using errcode='22023'; end if;
 -- Retire only unbound older quotes. Row predicates are rechecked after concurrent binding.
 update public.payment_sessions set status='cancelled'
 where user_id=p_user and requested_plan::text=p_plan and status='pending' and pi_payment_id is null
   and coalesce(discount_code,'')=coalesce(discount,'')
   and (original_amount_pi is distinct from base or created_at<=now()-interval '30 minutes'
     or amount_pi is distinct from trunc(base*(1-coalesce(discount_percent,0)/100),7));
 -- Recheck after the update: a concurrent Pi binding must never lead to a second charge.
 select * into s from public.payment_sessions where user_id=p_user and requested_plan::text=p_plan
   and status in ('pending','approved') and pi_payment_id is not null order by created_at asc limit 1;
 if found then return to_jsonb(s) || jsonb_build_object('resumingLinkedPayment',true); end if;
 select * into s from public.payment_sessions where user_id=p_user and requested_plan::text=p_plan
   and status='pending' and pi_payment_id is null and created_at>now()-interval '30 minutes'
   and original_amount_pi=base and coalesce(discount_code,'')=coalesce(discount,'')
   order by created_at desc limit 1;
 if found then return to_jsonb(s); end if;
 if (select count(*) from public.payment_sessions where user_id=p_user and created_at>now()-interval '30 minutes') >= 10 then
   raise exception 'too_many_sessions' using errcode='22023'; end if;
 select * into p from public.plans where plan_id=p_plan and is_active for share;
 if not found then raise exception 'invalid_plan' using errcode='22023'; end if;
 amount:=base;
 if discount is not null then
   select * into d from public.discount_codes where code=discount for update;
   if not found or not d.is_active or d.expires_at<=now() or (d.applies_to_plan is not null and d.applies_to_plan<>p_plan) then
     raise exception 'invalid_discount' using errcode='22023'; end if;
   -- Bound capacity using completed count plus unpaid reservations. Linked payments keep
   -- their reservation until Pi confirms cancellation, even after the local link TTL.
   select count(*) into reserved from public.payment_sessions reserved_session where discount_code=d.code
     and status in ('pending','approved') and (pi_payment_id is not null or created_at>now()-interval '30 minutes')
     and (previous.id is null or reserved_session.id<>previous.id)
     and not exists(select 1 from public.payment_sessions child
       where child.retry_of_session_id=reserved_session.id and child.status in ('pending','approved')
         and (child.pi_payment_id is not null or child.created_at>now()-interval '30 minutes'));
   if d.max_uses is not null and d.used_count+reserved>=d.max_uses then raise exception 'discount_exhausted' using errcode='22023'; end if;
   amount:=trunc(base*(1-d.discount_percent/100),7);
 end if;
 -- Zero-value purchases need a separate redemption flow, never a fake Pi transaction.
 if amount<=0 then raise exception 'zero_amount_not_supported' using errcode='22023'; end if;
 insert into public.payment_sessions(user_id,requested_plan,amount_pi,original_amount_pi,discount_code,discount_percent,retry_of_session_id)
 values(p_user,p_plan::public.plan_type,amount,base,d.code,d.discount_percent,previous.id) returning * into s;
 return to_jsonb(s);
end $$;

REVOKE ALL ON FUNCTION public.create_quoted_checkout_session(uuid,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_quoted_checkout_session(uuid,text,uuid,text) TO service_role;
COMMIT;
