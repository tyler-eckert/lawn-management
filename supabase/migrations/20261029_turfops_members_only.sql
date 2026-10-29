-- TurfOps: members-only access. Run once in the Supabase SQL editor (project uomhdexfwovuovtarycz).

-- The one-time read test is done; its token table is no longer used by bhyve-control.
drop table if exists public.turfops_control_probe;

-- Who may see TurfOps. Other accounts on this project (e.g. the band app) are kept out.
create table if not exists public.turfops_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.turfops_members enable row level security;
drop policy if exists "members: see own row" on public.turfops_members;
create policy "members: see own row" on public.turfops_members for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.turfops_members from anon;
grant select on public.turfops_members to authenticated;
insert into public.turfops_members (user_id) values ('065a3d99-eddf-484f-a541-737ce15583ed') on conflict do nothing;   -- eckert.tyler@gmail.com

create or replace function public.is_turfops_member()
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.turfops_members m where m.user_id = (select auth.uid())) $$;
revoke all on function public.is_turfops_member() from public, anon;
grant execute on function public.is_turfops_member() to authenticated;

-- TurfOps tables: members can read; nobody writes from the browser (the pullers use the service role).
do $$
declare t text;
begin
  foreach t in array array['weather_daily','irrigation_runs','irrigation_zones','turf_kc_monthly','mower_activity'] loop
    execute format('drop policy if exists "auth full access" on public.%I', t);
    execute format('drop policy if exists "turfops members: read" on public.%I', t);
    execute format('create policy "turfops members: read" on public.%I for select to authenticated using ((select public.is_turfops_member()))', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated, anon', t);
  end loop;
end $$;

-- Views now check the reader's own access (they used to run with the owner's rights and skip RLS).
alter view public.et_balance_by_zone set (security_invoker = true);
alter view public.mower_zone_daily set (security_invoker = true);

-- To let someone in later:
--   insert into public.turfops_members (user_id) select id from auth.users where email = 'someone@example.com';
