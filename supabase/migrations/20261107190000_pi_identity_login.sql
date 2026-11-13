begin;
-- Service-only capabilities. Never expose rows or RPCs to anon/authenticated.
create table public.pi_login_challenges (
 id uuid primary key default gen_random_uuid(),
 browser_hash text not null unique, device_hash text not null unique,
 purpose text not null check(purpose in ('login','link')),
 owner_id uuid references auth.users(id) on delete cascade,
 app_namespace text not null,
 display_code text not null,
 expires_at timestamptz not null default now()+interval '5 minutes',
 state text not null default 'pending' check(state in ('pending','approved','consumed','cancelled')),
 pi_uid text, pi_username text,
 check ((purpose='login' and owner_id is null) or (purpose='link' and owner_id is not null))
);
create table public.pi_account_identities (
 app_namespace text not null, pi_uid text not null,
 user_id uuid not null references auth.users(id) on delete cascade,
 username text not null, created_at timestamptz not null default now(),
 primary key(app_namespace,pi_uid), unique(app_namespace,user_id)
);
create table public.pi_auth_limits (
 bucket text primary key, hits integer not null, expires_at timestamptz not null
);
create table public.pi_email_challenges (
 user_id uuid primary key references auth.users(id) on delete cascade,
 email text not null, code_hash text not null,
 expires_at timestamptz not null default now()+interval '10 minutes',
 attempts integer not null default 0, consumed boolean not null default false
);
create index pi_login_expiry_idx on public.pi_login_challenges(expires_at);
create index pi_rate_expiry_idx on public.pi_auth_limits(expires_at);
alter table public.pi_login_challenges enable row level security;
alter table public.pi_account_identities enable row level security;
alter table public.pi_auth_limits enable row level security;
alter table public.pi_email_challenges enable row level security;
revoke all on public.pi_login_challenges, public.pi_account_identities, public.pi_auth_limits, public.pi_email_challenges from public, anon, authenticated;
grant all on public.pi_login_challenges, public.pi_account_identities, public.pi_auth_limits, public.pi_email_challenges to service_role;

create function public.pi_auth_rate(p_bucket text, p_limit int, p_seconds int)
returns boolean language plpgsql security definer set search_path='' as $$
declare n int;
begin
 insert into public.pi_auth_limits as l values(p_bucket,1,now()+make_interval(secs=>p_seconds))
 on conflict(bucket) do update set hits=case when l.expires_at<=now() then 1 else l.hits+1 end,
 expires_at=case when l.expires_at<=now() then now()+make_interval(secs=>p_seconds) else l.expires_at end
 returning hits into n;
 return n<=p_limit;
end; $$;

create function public.pi_auth_bind(p_namespace text,p_uid text,p_user uuid,p_username text)
returns uuid language plpgsql security definer set search_path='' as $$
declare existing uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_namespace||':'||p_uid,0));
 select user_id into existing from public.pi_account_identities where app_namespace=p_namespace and pi_uid=p_uid;
 if existing is not null then
  if existing<>p_user then raise exception 'identity_conflict'; end if;
  return existing;
 end if;
 insert into public.pi_account_identities(app_namespace,pi_uid,user_id,username) values(p_namespace,p_uid,p_user,p_username);
 return p_user;
end; $$;

-- Lookup is restricted to service_role and the internal non-deliverable namespace.
create function public.pi_auth_internal_user(p_email text)
returns uuid language sql security definer set search_path='' as $$
 select id from auth.users where lower(email)=lower(p_email) and email like '%@pi-auth.invalid'
 and raw_app_meta_data->>'pi_internal'='true' limit 1;
$$;
create function public.pi_auth_email_exists(p_email text)
returns boolean language sql security definer set search_path='' as $$
 select exists(select 1 from auth.users where lower(email)=lower(p_email));
$$;
create function public.pi_auth_verify_email(p_user uuid,p_hash text)
returns text language plpgsql security definer set search_path='' as $$
declare c public.pi_email_challenges;
begin
 select * into c from public.pi_email_challenges where user_id=p_user for update;
 if not found or c.consumed or c.expires_at<=now() or c.attempts>=5 then return null; end if;
 update public.pi_email_challenges set attempts=attempts+1 where user_id=p_user;
 if c.code_hash<>p_hash then return null; end if;
 update public.pi_email_challenges set consumed=true where user_id=p_user;
 return c.email;
end; $$;
revoke all on function public.pi_auth_rate(text,int,int),public.pi_auth_bind(text,text,uuid,text),public.pi_auth_internal_user(text),public.pi_auth_email_exists(text),public.pi_auth_verify_email(uuid,text) from public,anon,authenticated;
grant execute on function public.pi_auth_rate(text,int,int),public.pi_auth_bind(text,text,uuid,text),public.pi_auth_internal_user(text),public.pi_auth_email_exists(text),public.pi_auth_verify_email(uuid,text) to service_role;
commit;
