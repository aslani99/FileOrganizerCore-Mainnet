-- One reviewed Testnet settlement. No session/profile/plan mutation or entitlement inference.
create table if not exists public.legacy_pi_recoveries (
 payment_id text primary key check (payment_id='TxAukfUSGN7V1pTOEsNN1SUpHiyf'),
 tx_id text not null check (tx_id='fbe8485f450a31140dab386b6d0b13a92449afa44f4d1ced1ad7988daaa949e2'),
 amount_pi numeric not null check(amount_pi=18),
 network text not null check(network='Pi Testnet'),
 session_token_sha256 text not null,
 state text not null check(state in ('prepared','confirmed')),
 attempt uuid not null,
 lease_until timestamptz not null,
 initiated_by uuid not null references auth.users(id),
 confirmed_by uuid references auth.users(id),
 created_at timestamptz not null default now(),
 confirmed_at timestamptz,
 entitlement_note text not null default 'Historical Testnet settlement only; no subscription granted. Original session missing.'
);
alter table public.legacy_pi_recoveries enable row level security;
revoke all on public.legacy_pi_recoveries from public, anon, authenticated;
grant select on public.legacy_pi_recoveries to service_role;
create or replace function public.record_legacy_pi_recovery(p_admin uuid,p_attempt uuid,p_phase text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 pid constant text := 'TxAukfUSGN7V1pTOEsNN1SUpHiyf';
 tid constant text := 'fbe8485f450a31140dab386b6d0b13a92449afa44f4d1ced1ad7988daaa949e2';
 fingerprint constant text := '01e7a97c331cb0eebb3189b909b1032ecefc94d26324d200e7fa2bc88b30ccb6';
 r public.legacy_pi_recoveries%rowtype;
begin
 if not exists(select 1 from public.admin_users where user_id=p_admin and is_active and role='owner') then
  raise exception 'owner_required' using errcode='42501'; end if;
 if p_attempt is null or p_phase is null or p_phase not in ('prepare','confirm') then raise exception 'invalid_recovery_phase'; end if;
 perform pg_advisory_xact_lock(221022,18);
 select * into r from public.legacy_pi_recoveries where payment_id=pid for update;
 if p_phase='prepare' then
  if exists(select 1 from public.payment_sessions where pi_payment_id=pid or tx_id=tid
    or encode(sha256(convert_to(token::text,'UTF8')),'hex')=fingerprint) then raise exception 'session_exists'; end if;
  if r.state='confirmed' then return jsonb_build_object('state','confirmed'); end if;
  if r.lease_until>now() then return jsonb_build_object('state','busy'); end if;
  insert into public.legacy_pi_recoveries(payment_id,tx_id,amount_pi,network,session_token_sha256,state,attempt,lease_until,initiated_by)
   values(pid,tid,18,'Pi Testnet',fingerprint,'prepared',p_attempt,now()+interval '150 seconds',p_admin)
   on conflict(payment_id) do update set attempt=p_attempt,lease_until=excluded.lease_until;
 else
  if r.payment_id is null then raise exception 'recovery_not_prepared'; end if;
  if r.state='confirmed' then return jsonb_build_object('state','confirmed'); end if;
  if r.attempt<>p_attempt then raise exception 'recovery_attempt_mismatch'; end if;
  update public.legacy_pi_recoveries set state='confirmed',confirmed_at=now(),confirmed_by=p_admin where payment_id=pid;
 end if;
 insert into public.admin_audit_logs(admin_user_id,action,target_type,target_id,metadata)
  values(p_admin,'legacy_pi_recovery_'||p_phase,'pi_testnet_payment',pid,
   jsonb_build_object('amountPi',18,'network','Pi Testnet','txId',tid,'attempt',p_attempt,'subscriptionGranted',false));
 return jsonb_build_object('state',case when p_phase='prepare' then 'prepared' else 'confirmed' end);
end $$;
revoke all on function public.record_legacy_pi_recovery(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.record_legacy_pi_recovery(uuid,uuid,text) to service_role;
