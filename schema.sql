-- ============================================================
-- Fleet Maintenance Log — Supabase schema
-- Run this once in your Supabase project's SQL Editor
-- (Dashboard → SQL Editor → New query → paste all of this → Run)
-- ============================================================

-- 1. Profiles table: one row per user, holds their role.
--    A new row is created automatically whenever someone signs up.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'staff' check (role in ('staff','supervisor')),
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

-- Everyone logged in can see everyone's profile (needed to show names, roles).
create policy "profiles are viewable by authenticated users"
  on public.profiles for select
  using (auth.role() = 'authenticated');

-- Users can update their own full_name, but NOT their own role
-- (role changes are done by an admin directly in Supabase Studio).
create policy "users can update their own name only"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- 2. Automatically create a profile row when someone signs up.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, new.raw_user_meta_data->>'full_name', 'staff');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 3. Helper function: is the current logged-in user a Supervisor?
create function public.is_supervisor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.profiles
    where id = auth.uid() and role = 'supervisor'
  );
$$;

-- 4. Maintenance requests table.
create table public.maintenance_requests (
  id uuid primary key default gen_random_uuid(),
  req_no text not null unique,
  plate text not null,
  pcn text,
  department text not null check (department in (
    'Construction Division',
    'Planning & Design Division',
    'Equipment Management Division',
    'Maintenance Division',
    'Right of Way and Legal Division',
    'Finance Division',
    'Quality Assurance and Hydrology Division',
    'Administrative Division'
  )),
  repair_type text not null check (repair_type in (
    'Preventive Maintenance',
    'Corrective Maintenance',
    'Express Maintenance (minor jobs)'
  )),
  date_requested date not null,
  date_in date,
  date_out date,
  notes text,
  status text not null default 'Requested' check (status in (
    'Requested','Approved','In Progress','Completed','Closed','On Hold','Cancelled'
  )),
  created_by uuid references public.profiles(id),
  updated_at timestamptz default now()
);

alter table public.maintenance_requests enable row level security;

-- Any logged-in EMD user can see every request (this is your "shared data" requirement).
create policy "requests are viewable by authenticated users"
  on public.maintenance_requests for select
  using (auth.role() = 'authenticated');

-- Any logged-in user can create a new request.
create policy "authenticated users can insert requests"
  on public.maintenance_requests for insert
  with check (auth.role() = 'authenticated' and created_by = auth.uid());

-- Update rule — this is where real permission enforcement happens:
--   * A Closed or Cancelled request can only be touched further by a Supervisor.
--   * Setting status to Completed / Closed / On Hold / Cancelled requires Supervisor.
--   * Everything else (Staff creating/advancing a normal request) is allowed.
create policy "role-gated updates"
  on public.maintenance_requests for update
  using (
    status not in ('Closed','Cancelled') or public.is_supervisor()
  )
  with check (
    status not in ('Completed','Closed','On Hold','Cancelled') or public.is_supervisor()
  );

-- No delete policy is created, so deleting requests is disabled by default
-- for everyone (including via the API) unless you decide to add one later.

-- 5. Turn on Realtime so all connected browsers get live updates.
alter publication supabase_realtime add table public.maintenance_requests;
