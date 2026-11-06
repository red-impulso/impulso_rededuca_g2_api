-- Daily attendance per course (M2-1): one record per student per day with
-- present/absent/late/justified and who took the list.

create table public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles (id) on delete cascade,
  course_id uuid not null references public.courses (id) on delete cascade,
  date date not null,
  status text not null check (status in ('present', 'absent', 'late', 'justified')),
  recorded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, date)
);

alter table public.attendance_records enable row level security;

create policy "Members can view attendance in their school"
  on public.attendance_records for select to authenticated
  using (exists (
    select 1 from public.courses
    where courses.id = attendance_records.course_id
      and public.is_member(courses.school_id)
  ));

-- A teacher with a subject in the course, or a school admin, can take the list.
create policy "Course teachers and school admins can record attendance"
  on public.attendance_records for insert to authenticated
  with check (exists (
    select 1 from public.courses
    where courses.id = attendance_records.course_id
      and (
        public.is_school_admin(courses.school_id)
        or exists (
          select 1 from public.subjects
          where subjects.course_id = courses.id
            and subjects.teacher_id = auth.uid()
        )
      )
  ));

create policy "Course teachers and school admins can update attendance"
  on public.attendance_records for update to authenticated
  using (exists (
    select 1 from public.courses
    where courses.id = attendance_records.course_id
      and (
        public.is_school_admin(courses.school_id)
        or exists (
          select 1 from public.subjects
          where subjects.course_id = courses.id
            and subjects.teacher_id = auth.uid()
        )
      )
  ))
  with check (exists (
    select 1 from public.courses
    where courses.id = attendance_records.course_id
      and (
        public.is_school_admin(courses.school_id)
        or exists (
          select 1 from public.subjects
          where subjects.course_id = courses.id
            and subjects.teacher_id = auth.uid()
        )
      )
  ));

create policy "School admins can delete attendance"
  on public.attendance_records for delete to authenticated
  using (exists (
    select 1 from public.courses
    where courses.id = attendance_records.course_id
      and public.is_school_admin(courses.school_id)
  ));
