-- Multi-school memberships: a user can belong to several schools, with one row
-- per (user, school, role). Existing profiles.school_id/role data is backfilled;
-- those legacy columns stay during the transition and are dropped later.

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  school_id uuid not null references public.schools (id) on delete cascade,
  role text not null check (role in ('admin', 'director', 'teacher', 'guardian', 'student')),
  created_at timestamptz not null default now(),
  unique (user_id, school_id, role)
);

insert into public.memberships (user_id, school_id, role)
select id, school_id, role
from public.profiles
where school_id is not null;

-- Helpers (security definer to avoid recursive RLS lookups on memberships).
-- current_school_id() no longer drives policies: users can have several schools.

create or replace function public.is_member(p_school_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships
    where user_id = auth.uid() and school_id = p_school_id
  )
$$;

create or replace function public.is_school_admin(p_school_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships
    where user_id = auth.uid() and school_id = p_school_id and role = 'admin'
  )
$$;

create or replace function public.shares_school(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships mine
    join public.memberships theirs on theirs.school_id = mine.school_id
    where mine.user_id = auth.uid() and theirs.user_id = p_user_id
  )
$$;

create or replace function public.can_administer(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships mine
    join public.memberships theirs on theirs.school_id = mine.school_id
    where mine.user_id = auth.uid() and mine.role = 'admin' and theirs.user_id = p_user_id
  )
$$;

alter table public.memberships enable row level security;

-- memberships
create policy "Members can view memberships in their schools"
  on public.memberships for select to authenticated
  using (user_id = auth.uid() or public.is_member(school_id));

create policy "School admins can add members"
  on public.memberships for insert to authenticated
  with check (public.is_school_admin(school_id));

create policy "School admins can update memberships"
  on public.memberships for update to authenticated
  using (public.is_school_admin(school_id))
  with check (public.is_school_admin(school_id));

create policy "Users can leave and admins can remove members"
  on public.memberships for delete to authenticated
  using (user_id = auth.uid() or public.is_school_admin(school_id));

-- schools (insert stays open; update/delete already call is_school_admin)
drop policy "Members can view their school" on public.schools;
create policy "Members can view their schools"
  on public.schools for select to authenticated
  using (public.is_member(id));

-- profiles
drop policy "Users can view profiles in their school" on public.profiles;
create policy "Users can view profiles in their schools"
  on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_school(id));

drop policy "Users and school admins can update profiles" on public.profiles;
create policy "Users and school admins can update profiles"
  on public.profiles for update to authenticated
  using (id = auth.uid() or public.can_administer(id))
  with check (id = auth.uid() or public.can_administer(id));

drop policy "School admins can delete profiles" on public.profiles;
create policy "School admins can delete profiles"
  on public.profiles for delete to authenticated
  using (public.can_administer(id));

-- courses
drop policy "Members can view their school's courses" on public.courses;
create policy "Members can view their school's courses"
  on public.courses for select to authenticated
  using (public.is_member(school_id));

drop policy "Members can create courses in their school" on public.courses;
create policy "Members can create courses in their school"
  on public.courses for insert to authenticated
  with check (public.is_member(school_id));

drop policy "Members can update their school's courses" on public.courses;
create policy "Members can update their school's courses"
  on public.courses for update to authenticated
  using (public.is_member(school_id))
  with check (public.is_member(school_id));

drop policy "Members can delete their school's courses" on public.courses;
create policy "Members can delete their school's courses"
  on public.courses for delete to authenticated
  using (public.is_member(school_id));

-- subjects
drop policy "Members can view subjects in their school" on public.subjects;
create policy "Members can view subjects in their school"
  on public.subjects for select to authenticated
  using (exists (
    select 1 from public.courses
    where courses.id = subjects.course_id
      and public.is_member(courses.school_id)
  ));

drop policy "Members can create subjects in their school" on public.subjects;
create policy "Members can create subjects in their school"
  on public.subjects for insert to authenticated
  with check (exists (
    select 1 from public.courses
    where courses.id = subjects.course_id
      and public.is_member(courses.school_id)
  ));

drop policy "Members can update subjects in their school" on public.subjects;
create policy "Members can update subjects in their school"
  on public.subjects for update to authenticated
  using (exists (
    select 1 from public.courses
    where courses.id = subjects.course_id
      and public.is_member(courses.school_id)
  ))
  with check (exists (
    select 1 from public.courses
    where courses.id = subjects.course_id
      and public.is_member(courses.school_id)
  ));

drop policy "Members can delete subjects in their school" on public.subjects;
create policy "Members can delete subjects in their school"
  on public.subjects for delete to authenticated
  using (exists (
    select 1 from public.courses
    where courses.id = subjects.course_id
      and public.is_member(courses.school_id)
  ));

-- enrollments
drop policy "Members can view enrollments in their school" on public.enrollments;
create policy "Members can view enrollments in their school"
  on public.enrollments for select to authenticated
  using (exists (
    select 1 from public.courses
    where courses.id = enrollments.course_id
      and public.is_member(courses.school_id)
  ));

drop policy "Members can create enrollments in their school" on public.enrollments;
create policy "Members can create enrollments in their school"
  on public.enrollments for insert to authenticated
  with check (exists (
    select 1 from public.courses
    where courses.id = enrollments.course_id
      and public.is_member(courses.school_id)
  ));

drop policy "Members can update enrollments in their school" on public.enrollments;
create policy "Members can update enrollments in their school"
  on public.enrollments for update to authenticated
  using (exists (
    select 1 from public.courses
    where courses.id = enrollments.course_id
      and public.is_member(courses.school_id)
  ))
  with check (exists (
    select 1 from public.courses
    where courses.id = enrollments.course_id
      and public.is_member(courses.school_id)
  ));

drop policy "Members can delete enrollments in their school" on public.enrollments;
create policy "Members can delete enrollments in their school"
  on public.enrollments for delete to authenticated
  using (exists (
    select 1 from public.courses
    where courses.id = enrollments.course_id
      and public.is_member(courses.school_id)
  ));
