-- RedEduca base schema: schools, profiles, courses, subjects, enrollments.
-- RLS: school-scoped, members read/edit only their own school's data.

create table public.schools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  school_id uuid references public.schools (id) on delete set null,
  full_name text,
  role text not null default 'student' check (role in ('admin', 'teacher', 'student')),
  created_at timestamptz not null default now()
);

create table public.courses (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  year int not null,
  division text not null,
  shift text not null check (shift in ('morning', 'afternoon', 'evening')),
  school_year int not null,
  created_at timestamptz not null default now(),
  unique (school_id, year, division, shift, school_year)
);

create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  teacher_id uuid references public.profiles (id) on delete set null,
  name text not null,
  created_at timestamptz not null default now(),
  unique (course_id, name)
);

create table public.enrollments (
  student_id uuid not null references public.profiles (id) on delete cascade,
  course_id uuid not null references public.courses (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (student_id, course_id)
);

-- Helpers (security definer to avoid recursive RLS lookups on profiles)
create or replace function public.current_school_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select school_id from public.profiles where id = auth.uid()
$$;

create or replace function public.is_school_admin(p_school_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and school_id = p_school_id and role = 'admin'
  )
$$;

create or replace function public.protect_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() = new.id
     and not public.is_school_admin(old.school_id)
     and (new.role is distinct from old.role
          or new.school_id is distinct from old.school_id) then
    raise exception 'Only school admins can change role or school';
  end if;
  return new;
end;
$$;

create trigger protect_profile_privileges
  before update on public.profiles
  for each row execute function public.protect_profile_privileges();

alter table public.schools enable row level security;
alter table public.profiles enable row level security;
alter table public.courses enable row level security;
alter table public.subjects enable row level security;
alter table public.enrollments enable row level security;

-- schools
create policy "Members can view their school"
  on public.schools for select to authenticated
  using (id = public.current_school_id());

create policy "Authenticated users can create schools"
  on public.schools for insert to authenticated
  with check (true);

create policy "Admins can update their school"
  on public.schools for update to authenticated
  using (public.is_school_admin(id))
  with check (public.is_school_admin(id));

create policy "Admins can delete their school"
  on public.schools for delete to authenticated
  using (public.is_school_admin(id));

-- profiles
create policy "Users can view profiles in their school"
  on public.profiles for select to authenticated
  using (id = auth.uid() or school_id = public.current_school_id());

create policy "Users can create their own profile"
  on public.profiles for insert to authenticated
  with check (id = auth.uid());

create policy "Users and school admins can update profiles"
  on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_school_admin(school_id))
  with check (id = auth.uid() or public.is_school_admin(school_id));

create policy "School admins can delete profiles"
  on public.profiles for delete to authenticated
  using (public.is_school_admin(school_id));

-- courses
create policy "Members can view their school's courses"
  on public.courses for select to authenticated
  using (school_id = public.current_school_id());

create policy "Members can create courses in their school"
  on public.courses for insert to authenticated
  with check (school_id = public.current_school_id());

create policy "Members can update their school's courses"
  on public.courses for update to authenticated
  using (school_id = public.current_school_id())
  with check (school_id = public.current_school_id());

create policy "Members can delete their school's courses"
  on public.courses for delete to authenticated
  using (school_id = public.current_school_id());

-- subjects
create policy "Members can view subjects in their school"
  on public.subjects for select to authenticated
  using (exists (
    select 1 from public.courses
    where courses.id = subjects.course_id
      and courses.school_id = public.current_school_id()
  ));

create policy "Members can create subjects in their school"
  on public.subjects for insert to authenticated
  with check (exists (
    select 1 from public.courses
    where courses.id = subjects.course_id
      and courses.school_id = public.current_school_id()
  ));

create policy "Members can update subjects in their school"
  on public.subjects for update to authenticated
  using (exists (
    select 1 from public.courses
    where courses.id = subjects.course_id
      and courses.school_id = public.current_school_id()
  ))
  with check (exists (
    select 1 from public.courses
    where courses.id = subjects.course_id
      and courses.school_id = public.current_school_id()
  ));

create policy "Members can delete subjects in their school"
  on public.subjects for delete to authenticated
  using (exists (
    select 1 from public.courses
    where courses.id = subjects.course_id
      and courses.school_id = public.current_school_id()
  ));

-- enrollments
create policy "Members can view enrollments in their school"
  on public.enrollments for select to authenticated
  using (exists (
    select 1 from public.courses
    where courses.id = enrollments.course_id
      and courses.school_id = public.current_school_id()
  ));

create policy "Members can create enrollments in their school"
  on public.enrollments for insert to authenticated
  with check (exists (
    select 1 from public.courses
    where courses.id = enrollments.course_id
      and courses.school_id = public.current_school_id()
  ));

create policy "Members can update enrollments in their school"
  on public.enrollments for update to authenticated
  using (exists (
    select 1 from public.courses
    where courses.id = enrollments.course_id
      and courses.school_id = public.current_school_id()
  ))
  with check (exists (
    select 1 from public.courses
    where courses.id = enrollments.course_id
      and courses.school_id = public.current_school_id()
  ));

create policy "Members can delete enrollments in their school"
  on public.enrollments for delete to authenticated
  using (exists (
    select 1 from public.courses
    where courses.id = enrollments.course_id
      and courses.school_id = public.current_school_id()
  ));
