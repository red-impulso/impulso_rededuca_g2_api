-- Teacher grade sheet (M1-1): one grade per (student, subject, period) plus
-- grade_changes, an append-only audit trail with who changed each grade, when
-- and what the previous value was.

create table public.grades (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles (id) on delete cascade,
  subject_id uuid not null references public.subjects (id) on delete cascade,
  period_id uuid not null references public.periods (id) on delete cascade,
  value numeric(4,2) not null check (value between 1 and 10),
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, subject_id, period_id)
);

create table public.grade_changes (
  id uuid primary key default gen_random_uuid(),
  grade_id uuid not null references public.grades (id) on delete cascade,
  previous_value numeric(4,2),
  new_value numeric(4,2) not null,
  changed_by uuid references public.profiles (id) on delete set null,
  changed_at timestamptz not null default now()
);

alter table public.grades enable row level security;
alter table public.grade_changes enable row level security;

-- grades
create policy "Members can view grades in their school"
  on public.grades for select to authenticated
  using (exists (
    select 1
    from public.subjects
    join public.courses on courses.id = subjects.course_id
    where subjects.id = grades.subject_id
      and public.is_member(courses.school_id)
  ));

create policy "Subject teachers and school admins can record grades"
  on public.grades for insert to authenticated
  with check (exists (
    select 1
    from public.subjects
    join public.courses on courses.id = subjects.course_id
    where subjects.id = grades.subject_id
      and (
        subjects.teacher_id = auth.uid()
        or public.is_school_admin(courses.school_id)
      )
  ));

create policy "Subject teachers and school admins can update grades"
  on public.grades for update to authenticated
  using (exists (
    select 1
    from public.subjects
    join public.courses on courses.id = subjects.course_id
    where subjects.id = grades.subject_id
      and (
        subjects.teacher_id = auth.uid()
        or public.is_school_admin(courses.school_id)
      )
  ))
  with check (exists (
    select 1
    from public.subjects
    join public.courses on courses.id = subjects.course_id
    where subjects.id = grades.subject_id
      and (
        subjects.teacher_id = auth.uid()
        or public.is_school_admin(courses.school_id)
      )
  ));

create policy "School admins can delete grades"
  on public.grades for delete to authenticated
  using (exists (
    select 1
    from public.subjects
    join public.courses on courses.id = subjects.course_id
    where subjects.id = grades.subject_id
      and public.is_school_admin(courses.school_id)
  ));

-- grade_changes: append-only audit, no update/delete policies on purpose.
create policy "Members can view grade changes in their school"
  on public.grade_changes for select to authenticated
  using (exists (
    select 1
    from public.grades
    join public.subjects on subjects.id = grades.subject_id
    join public.courses on courses.id = subjects.course_id
    where grades.id = grade_changes.grade_id
      and public.is_member(courses.school_id)
  ));

create policy "Subject teachers and school admins can log grade changes"
  on public.grade_changes for insert to authenticated
  with check (exists (
    select 1
    from public.grades
    join public.subjects on subjects.id = grades.subject_id
    join public.courses on courses.id = subjects.course_id
    where grades.id = grade_changes.grade_id
      and (
        subjects.teacher_id = auth.uid()
        or public.is_school_admin(courses.school_id)
      )
  ));
