begin;
-- Internal Pi alias is operational metadata, never a second user-supplied email.
-- The table already has RLS and is service_role-only.
alter table public.pi_account_identities
 add column if not exists internal_auth_email text
 check (internal_auth_email is null or internal_auth_email like '%@pi-auth.invalid');
comment on column public.pi_account_identities.internal_auth_email is
 'Original internal Pi authentication alias. Verified human email remains in auth.users.email.';
update public.pi_account_identities p
 set internal_auth_email=u.email
 from auth.users u
 where u.id=p.user_id and u.email like '%@pi-auth.invalid'
 and p.internal_auth_email is null;

create or replace function public.pi_auth_bind(p_namespace text,p_uid text,p_user uuid,p_username text)
returns uuid language plpgsql security definer set search_path='' as $$
declare existing uuid; alias text;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_namespace||':'||p_uid,0));
 select user_id into existing from public.pi_account_identities where app_namespace=p_namespace and pi_uid=p_uid;
 select email into alias from auth.users where id=p_user and email like '%@pi-auth.invalid';
 if existing is not null then
  if existing<>p_user then raise exception 'identity_conflict'; end if;
  update public.pi_account_identities set username=p_username,
   internal_auth_email=coalesce(internal_auth_email,alias)
   where app_namespace=p_namespace and pi_uid=p_uid;
  return existing;
 end if;
 insert into public.pi_account_identities(app_namespace,pi_uid,user_id,username,internal_auth_email)
 values(p_namespace,p_uid,p_user,p_username,alias);
 return p_user;
end; $$;
revoke all on function public.pi_auth_bind(text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.pi_auth_bind(text,text,uuid,text) to service_role;
commit;
