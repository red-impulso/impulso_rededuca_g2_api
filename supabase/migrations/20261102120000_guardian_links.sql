-- Guardian-student links (backs GET /me/students) and the split name
-- columns the endpoint returns: profiles only had full_name.
-- courses already has year/division/shift from the initial schema, so this
-- migration doesn't touch it. full_name stays; first/last name are nullable
-- because existing rows can't be split reliably.

alter table public.profiles
  add column first_name text,
  add column last_name text;

create table public.guardian_links (
  guardian_id uuid not null references public.profiles (id) on delete cascade,
  student_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (guardian_id, student_id),
  check (guardian_id <> student_id)
);

alter table public.guardian_links enable row level security;

create policy "Guardians and schoolmates can view guardian links"
  on public.guardian_links for select to authenticated
  using (
    guardian_id = auth.uid()
    or student_id = auth.uid()
    or public.shares_school(student_id)
  );

create policy "School admins can create guardian links"
  on public.guardian_links for insert to authenticated
  with check (public.can_administer(student_id));

create policy "School admins can update guardian links"
  on public.guardian_links for update to authenticated
  using (public.can_administer(student_id))
  with check (public.can_administer(student_id));

create policy "School admins can delete guardian links"
  on public.guardian_links for delete to authenticated
  using (public.can_administer(student_id));
