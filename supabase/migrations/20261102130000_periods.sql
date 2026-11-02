-- Academic periods per school (trimesters, quarters...), e.g. "1.er trimestre".
-- Needed by the demo seed (B-08); attendance/grades features will hang off it.

create table public.periods (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  name text not null,
  start_date date not null,
  end_date date not null,
  created_at timestamptz not null default now(),
  unique (school_id, name),
  check (start_date < end_date)
);

alter table public.periods enable row level security;

create policy "Members can view their school's periods"
  on public.periods for select to authenticated
  using (public.is_member(school_id));

create policy "School admins can create periods"
  on public.periods for insert to authenticated
  with check (public.is_school_admin(school_id));

create policy "School admins can update periods"
  on public.periods for update to authenticated
  using (public.is_school_admin(school_id))
  with check (public.is_school_admin(school_id));

create policy "School admins can delete periods"
  on public.periods for delete to authenticated
  using (public.is_school_admin(school_id));
