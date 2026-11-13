begin;
-- The website may claim one independent Supabase session only after desktop redeem consumes
-- the same login challenge. Service-role access remains the only way to read or update this flag.
alter table public.pi_login_challenges
  add column if not exists browser_session_issued_at timestamptz;

comment on column public.pi_login_challenges.browser_session_issued_at is
  'One-time claim timestamp for the website session, available only after desktop redeem.';
commit;
