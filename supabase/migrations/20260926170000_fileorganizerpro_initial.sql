-- FileOrganizerPro initial database migration.
-- Generated from the current repository Supabase schema plus Admin Dashboard v1.
-- Auth users and production data are intentionally migrated separately.
-- Project-specific secrets/cron credentials are intentionally excluded.

create extension if not exists pgcrypto with schema extensions;

-- این فایل را در Supabase Dashboard -> SQL Editor کپی و اجرا کنید (یک‌بار، بعد از ساخت پروژه)

-- ============================================================
-- جدول پلن‌ها: قیمت‌گذاری، مدت اعتبار، سقف حجم و بج‌ها همگی از سمت سرور قابل تغییرند
-- (بدون نیاز به انتشار نسخه‌ی جدید اپ دسکتاپ). فقط خواندنی برای همه (RLS: select عمومی)،
-- نوشتن/ویرایش فقط از طریق Dashboard خود Supabase یا با service role.
-- ============================================================
create table public.plans (
  plan_id text primary key,              -- 'free' / 'pro' / 'max'
  name text not null,
  price_usd numeric not null,
  regular_price_usd numeric,             -- برای نمایش قیمت خط‌خورده (اگر تخفیف واقعی وجود داشته باشد)
  pi_amount numeric,                     -- مبلغ به پای؛ این مقدار دیگر دستی نیست — تابع
                                          -- refresh-pi-rate هر چند دقیقه یک‌بار آن را از نرخ لحظه‌ای
                                          -- Pi/USD بازمحاسبه و به‌روزرسانی می‌کند (به بخش پایین همین
                                          -- فایل، «به‌روزرسانی خودکار نرخ Pi»، نگاه کنید). اپ دسکتاپ و
                                          -- create-payment-session هر دو همین یک ستون را می‌خوانند،
                                          -- پس چیزی که به کاربر نشان داده می‌شود و چیزی که واقعاً از او
                                          -- گرفته می‌شود همیشه دقیقاً یکی است.
  pi_rate_updated_at timestamptz,        -- آخرین باری که pi_amount از نرخ زنده به‌روز شد
  pi_rate_source text,                   -- منبع نرخ (مثلاً 'coingecko') یا 'manual' اگر دستی ویرایش شده
  duration_days integer,                 -- مدت اعتبار پلن بر حسب روز؛ پلن رایگان ۳۰ روز است
  organization_limit_bytes bigint,       -- سقف حجم پلن؛ برای رایگان مجموعاً ۹ گیگابایت
  is_active boolean not null default true,
  display_order integer not null default 0,
  badge text,                            -- مثلاً 'Best Value' یا 'Launch Price'
  discount_percent integer
);

alter table public.plans enable row level security;
create policy "plans_select_all" on public.plans for select using (true);


-- مهاجرت امن برای دیتابیس‌هایی که قبلاً ساخته شده‌اند و ستون‌های نرخ زنده را ندارند.
alter table public.plans add column if not exists pi_rate_updated_at timestamptz;
alter table public.plans add column if not exists pi_rate_source text;

-- یک جدول تک‌ردیفه که فقط نرخ لحظه‌ی Pi/USD را نگه می‌دارد (برای نمایش مستقیم در اپ،
-- جدا از plans.pi_amount که مبلغ محاسبه‌شده‌ی هر پلن است). تابع refresh-pi-rate این
-- ردیف را هر چند دقیقه یک‌بار به‌روز می‌کند.
create table if not exists public.pi_rate (
  id integer primary key default 1,
  usd_rate numeric not null,
  updated_at timestamptz not null default now(),
  source text,
  constraint pi_rate_singleton check (id = 1)
);
alter table public.pi_rate enable row level security;
drop policy if exists "pi_rate_select_all" on public.pi_rate;
create policy "pi_rate_select_all" on public.pi_rate for select using (true);

-- ============================================================
-- جدول‌های اصلی قبلی (پروفایل کاربران و جلسات پرداخت)
-- ============================================================
create type plan_type as enum ('free', 'pro', 'max');

-- یک ردیف پروفایل/اشتراک به ازای هر کاربر (auth.users توسط خودِ Supabase Auth مدیریت می‌شود)
--
-- پلن رایگان ۳۰ روز اعتبار دارد و در طول این دوره مجموعاً تا ۹ گیگابایت برای هر اکانت مجاز است.
-- bytes_organized_total مصرف تجمعی را نگه می‌دارد تا محدودیت ۹ گیگابایت قابل اعمال باشد.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  plan plan_type not null default 'free',
  plan_expires_at timestamptz,
  bytes_organized_total bigint not null default 0,
  last_expired_plan text,
  created_at timestamptz not null default now()
);

-- مهاجرت امن برای دیتابیس‌هایی که قبلاً ساخته شده‌اند.
alter table public.profiles add column if not exists last_expired_plan text;
update public.profiles
set plan_expires_at = created_at + interval '30 days'
where plan = 'free' and plan_expires_at is null;

alter table public.profiles enable row level security;

-- هر کاربر فقط می‌تواند پروفایل خودش را ببیند؛ تغییر پلن فقط از طریق Edge Function (با service role) انجام می‌شود
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

-- وقتی یک کاربر جدید در Supabase Auth ثبت‌نام می‌کند، خودکار یک ردیف پروفایل (پلن رایگان) برایش بساز
create or replace function public.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, plan, plan_expires_at, last_expired_plan)
  values (new.id, new.email, 'free', now() + interval '30 days', null);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- وضعیت اشتراک را قبل از تحویل به کلاینت تازه می‌کند.
-- انقضای Pro/Max به Free منقضی‌شده برمی‌گردد و last_expired_plan عمداً حفظ می‌شود
-- تا اپ بتواند در هر اجرای جدید، هشدار پایان اشتراک را دوباره نشان دهد.
create or replace function public.refresh_subscription()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.profiles;
begin
  select * into p
  from public.profiles
  where id = auth.uid()
  for update;

  if p.id is null then
    return null;
  end if;

  if p.plan in ('pro', 'max')
     and p.plan_expires_at is not null
     and p.plan_expires_at <= now() then
    update public.profiles
      set plan = 'free',
          last_expired_plan = p.plan
      where id = p.id
      returning * into p;
  elsif p.plan = 'free'
        and p.plan_expires_at is not null
        and p.plan_expires_at <= now()
        and p.last_expired_plan is null then
    update public.profiles
      set last_expired_plan = 'free'
      where id = p.id
      returning * into p;
  end if;

  return p;
end;
$$;

grant execute on function public.refresh_subscription() to authenticated;

-- گزارش مصرف: یک تابع امن (security definer) که خودش auth.uid() فعلی را می‌گیرد.
-- مصرف تجمعی برای نمایش و اعمال سهمیه رایگان نگهداری می‌شود.
create function public.report_usage(bytes_organized bigint) returns void
language plpgsql security definer as $$
begin
  update public.profiles
    set bytes_organized_total = bytes_organized_total + greatest(bytes_organized, 0)
    where id = auth.uid();
end;
$$;

grant execute on function public.report_usage(bigint) to authenticated;

-- جلسات پرداخت پای (هر بار که کاربر روی «خرید این پلن» کلیک می‌کند، یک ردیف اینجا ساخته می‌شود)
create table public.payment_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  token text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  user_id uuid not null references auth.users (id) on delete cascade,
  requested_plan plan_type not null,
  amount_pi numeric not null,
  status text not null default 'pending', -- pending / approved / completed / cancelled / error
  pi_payment_id text,
  tx_id text,
  pi_user_uid text,                 -- verified Pi app user uid from /v2/me
  discount_code text,               -- کد تخفیفی که (اگر) موقع ساخت این جلسه اعمال شد
  discount_percent numeric,         -- درصد همان کد، در همان لحظه (حتی اگر بعداً درصد کد عوض شود، اینجا ثابت می‌ماند)
  created_at timestamptz not null default now()
);

alter table public.payment_sessions enable row level security;

-- Safe migration for databases created before Phase C payment hardening.
alter table public.payment_sessions add column if not exists pi_user_uid text;
alter table public.payment_sessions add column if not exists discount_code text;
alter table public.payment_sessions add column if not exists discount_percent numeric;
-- true یعنی «فعال‌سازی/جمع‌زدن مدت اشتراک روی profiles برای این جلسه انجام و تأیید شده».
-- pi-complete این را بعد از موفقیت set می‌کند؛ اگر fail شود، false می‌ماند و
-- payment-session-status در پولینگ بعدی خودش دوباره تلاش می‌کند (رجوع به
-- activateSubscriptionForSession در _shared/helpers.ts).
alter table public.payment_sessions add column if not exists subscription_synced boolean not null default false;
-- Backfill برای جلسات completed از قبل: تا امروز مسیر جبرانی اصلاً وجود نداشت و مشکلی هم گزارش
-- نشده، پس فرض می‌کنیم همه‌شان از قبل درست فعال شده‌اند. بدون این backfill، اولین polling بعد از
-- دیپلوی این تغییر، همه‌ی خریدهای قدیمی را دوباره پردازش می‌کرد و مدت اشتراک را اشتباهاً روی هم
-- می‌ریخت (double-stacking).
update public.payment_sessions set subscription_synced = true where status = 'completed';
create index if not exists payment_sessions_pi_payment_id_idx on public.payment_sessions (pi_payment_id);

-- کدهای تخفیف. برای ساختن/ویرایش/غیرفعال‌کردن یک کد، فقط کافیست مستقیماً از Table Editor
-- داشبورد Supabase یک ردیف اضافه/ویرایش کنید - هیچ کد یا دیپلویی لازم نیست.
--   code               : متنی که کاربر وارد می‌کند (حروف بزرگ/کوچک فرقی ندارد)
--   discount_percent   : عدد بین ۱ تا ۱۰۰ (مثلاً ۲۰ یعنی ۲۰٪ تخفیف)
--   is_active          : اگر false باشد، کد دیگر پذیرفته نمی‌شود (بدون نیاز به حذفش)
--   max_uses           : سقف تعداد دفعاتی که این کد کلاً قابل استفاده است؛ خالی = نامحدود
--   used_count         : خودکار توسط سرور شمرده می‌شود؛ دستی تغییرش ندهید
--   expires_at         : بعد از این تاریخ دیگر پذیرفته نمی‌شود؛ خالی = بدون انقضا
--   applies_to_plan    : 'pro' یا 'max' برای محدود کردن به یک پلن؛ خالی = روی هر دو پلن اعمال می‌شود
create table if not exists public.discount_codes (
  code text primary key,
  discount_percent numeric not null check (discount_percent > 0 and discount_percent <= 100),
  is_active boolean not null default true,
  max_uses integer,
  used_count integer not null default 0,
  expires_at timestamptz,
  applies_to_plan text check (applies_to_plan is null or applies_to_plan in ('pro', 'max')),
  created_at timestamptz not null default now()
);
alter table public.discount_codes enable row level security;
-- عمداً هیچ select policy‌ای برای کاربران عادی گذاشته نشده: کدها/درصدها فقط باید از طریق
-- create-payment-session (با service role، که RLS را دور می‌زند) خوانده و اعتبارسنجی شوند،
-- وگرنه هر کاربری می‌توانست کل لیست کدهای تخفیف را مستقیم از جدول بخواند.

-- کاربر فقط جلسات پرداخت خودش را می‌بیند؛ ساخت/تغییر ردیف‌ها فقط از طریق Edge Function (service role) است
create policy "payment_sessions_select_own" on public.payment_sessions
  for select using (auth.uid() = user_id);

-- ============================================================
-- Grantهای صریح روی Data API (طبق ایمیل Supabase: از ۳۰ اکتبر ۲۰۲۶ دیگر روی جدول‌های
-- public به‌صورت خودکار GRANT داده نمی‌شود. GRANT یک لایه‌ی کاملاً جدا از RLS Policy است -
-- بدونش، حتی با RLS درست، PostgREST/supabase-js با خطای «permission denied» برمی‌گردد.
-- این فایل چون یک اسکریپت raw است (نه migration رسمی Supabase CLI)، این تغییر برای جدول‌های
-- *موجود* همین الان اثری ندارد، ولی هر بار این فایل را از صفر روی یک پروژه/دیتابیس تازه
-- اجرا کنید (پروژه‌ی جدید، Preview Branch، یا بازسازی کامل)، این Grantها لازم می‌شوند.
-- ============================================================
grant select on public.plans to anon, authenticated, service_role;
grant select on public.pi_rate to anon, authenticated, service_role;
grant select on public.profiles to authenticated, service_role;
grant update on public.profiles to service_role;
grant select on public.payment_sessions to authenticated, service_role;
grant insert, update on public.payment_sessions to service_role;
grant select, update on public.discount_codes to service_role;

-- ============================================================
-- Admin Dashboard v1
-- ============================================================

-- FileOrganizerPro Admin Dashboard security foundation.
-- Run once in Supabase SQL Editor before deploying admin-api.
-- Never expose service_role or Pi server credentials to the browser.

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'admin' check (role in ('owner','admin','support')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;
grant select, insert, update, delete on public.admin_users to service_role;

create table if not exists public.admin_audit_logs (
  id bigint generated always as identity primary key,
  admin_user_id uuid not null references auth.users(id) on delete restrict,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.admin_audit_logs enable row level security;
grant insert, select on public.admin_audit_logs to service_role;
create index if not exists admin_audit_logs_created_at_idx on public.admin_audit_logs(created_at desc);
create index if not exists admin_audit_logs_admin_user_idx on public.admin_audit_logs(admin_user_id);
