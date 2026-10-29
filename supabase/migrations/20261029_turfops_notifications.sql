-- TurfOps: daily digest (email) + push notifications. Run once in the Supabase SQL editor (project uomhdexfwovuovtarycz).
-- Reuses the band app's secrets (VAPID keys, email sender); nothing new to set up in Edge Function secrets.

-- 1) Who gets what, per member. The app reads/writes your own row from the gear menu → Notifications.
create table if not exists public.turfops_notify (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  email        text,                                   -- blank = your sign-in email
  email_on     boolean not null default true,
  push_on      boolean not null default true,
  push_mode    text    not null default 'daily' check (push_mode in ('daily', 'alerts')),   -- alerts = only when action is needed
  send_hour    int     not null default 6 check (send_hour between 0 and 23),                -- Central time
  calc         jsonb,                                  -- latest budget-calculator numbers, saved by the app
  calc_at      timestamptz,
  last_sent_on date,
  updated_at   timestamptz not null default now()
);
alter table public.turfops_notify enable row level security;
drop policy if exists "turfops notify: own row" on public.turfops_notify;
create policy "turfops notify: own row" on public.turfops_notify for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_turfops_member()))
  with check (user_id = (select auth.uid()) and (select public.is_turfops_member()));
revoke all on public.turfops_notify from anon;
grant select, insert, update, delete on public.turfops_notify to authenticated;

-- 2) Phones / browsers that turned on push (one row per device).
create table if not exists public.turfops_push_subs (
  endpoint   text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  ua         text,
  created_at timestamptz not null default now()
);
alter table public.turfops_push_subs enable row level security;
drop policy if exists "turfops push: own devices" on public.turfops_push_subs;
create policy "turfops push: own devices" on public.turfops_push_subs for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_turfops_member()))
  with check (user_id = (select auth.uid()) and (select public.is_turfops_member()));
revoke all on public.turfops_push_subs from anon;
grant select, insert, update, delete on public.turfops_push_subs to authenticated;

-- 3) The token the schedule uses to call the function. No policies = only the service role can read it.
create table if not exists public.turfops_secrets (
  id int primary key default 1 check (id = 1),
  digest_token uuid not null default gen_random_uuid()
);
alter table public.turfops_secrets enable row level security;
revoke all on public.turfops_secrets from anon, authenticated;
insert into public.turfops_secrets (id) values (1) on conflict do nothing;

-- 4) Start Tyler with email + push every morning at 6 AM Central.
insert into public.turfops_notify (user_id, email_on, push_on, push_mode, send_hour)
values ('065a3d99-eddf-484f-a541-737ce15583ed', true, true, 'daily', 6)
on conflict (user_id) do nothing;

-- 5) Run every hour on the hour. The function only sends to people whose send hour (Central) it is,
--    once per day, so daylight saving time is handled and changing the hour in the app just works.
select cron.unschedule('turf-digest-hourly') where exists (select 1 from cron.job where jobname = 'turf-digest-hourly');
select cron.schedule('turf-digest-hourly', '0 * * * *', $$
  select net.http_get(
    url := 'https://uomhdexfwovuovtarycz.supabase.co/functions/v1/turf-digest?token=' || (select digest_token::text from public.turfops_secrets where id = 1),
    timeout_milliseconds := 60000
  );
$$);

-- To send one right now (ignores the hour and the once-a-day mark):
--   select net.http_get(url := 'https://uomhdexfwovuovtarycz.supabase.co/functions/v1/turf-digest?force=1&token=' || (select digest_token::text from public.turfops_secrets where id = 1), timeout_milliseconds := 60000);
