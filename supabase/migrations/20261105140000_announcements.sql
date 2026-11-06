-- Announcements (M3-1): school-wide, per-course or per-student posts. The API
-- filters per recipient; RLS mirrors it so a direct Supabase read can't leak
-- announcements that don't concern the caller.

create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  scope text not null check (scope in ('institution', 'course', 'student')),
  course_id uuid references public.courses (id) on delete cascade,
  student_id uuid references public.profiles (id) on delete cascade,
  title text not null check (length(btrim(title)) > 0),
  body text not null check (length(btrim(body)) > 0),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check (
    (scope = 'institution' and course_id is null and student_id is null)
    or (scope = 'course' and course_id is not null and student_id is null)
    or (scope = 'student' and student_id is not null and course_id is null)
  )
);

-- Manager = admin or director membership in the school.
create or replace function public.is_school_manager(p_school_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships
    where user_id = auth.uid()
      and school_id = p_school_id
      and role in ('admin', 'director')
  )
$$;

alter table public.announcements enable row level security;

create policy "Members can view announcements that concern them"
  on public.announcements for select to authenticated
  using (
    public.is_member(school_id)
    and (
      scope = 'institution'
      or (
        scope = 'course'
        and (
          public.is_school_manager(school_id)
          or exists (
            select 1 from public.subjects
            where subjects.course_id = announcements.course_id
              and subjects.teacher_id = auth.uid()
          )
          or exists (
            select 1 from public.enrollments
            where enrollments.course_id = announcements.course_id
              and enrollments.student_id = auth.uid()
          )
          or exists (
            select 1
            from public.guardian_links
            join public.enrollments
              on enrollments.student_id = guardian_links.student_id
            where guardian_links.guardian_id = auth.uid()
              and enrollments.course_id = announcements.course_id
          )
        )
      )
      or (
        scope = 'student'
        and (
          student_id = auth.uid()
          or public.is_school_manager(school_id)
          or exists (
            select 1 from public.guardian_links
            where guardian_links.guardian_id = auth.uid()
              and guardian_links.student_id = announcements.student_id
          )
        )
      )
    )
  );

-- Managers can post any scope; teachers only course scope for a course they
-- teach in.
create policy "Managers and course teachers can create announcements"
  on public.announcements for insert to authenticated
  with check (
    (
      scope = 'institution'
      and public.is_school_manager(school_id)
    )
    or (
      scope = 'course'
      and (
        public.is_school_manager(school_id)
        or exists (
          select 1
          from public.courses
          join public.subjects on subjects.course_id = courses.id
          where courses.id = announcements.course_id
            and courses.school_id = announcements.school_id
            and subjects.teacher_id = auth.uid()
        )
      )
    )
    or (
      scope = 'student'
      and public.is_school_manager(school_id)
    )
  );

create policy "School managers can update announcements"
  on public.announcements for update to authenticated
  using (public.is_school_manager(school_id))
  with check (public.is_school_manager(school_id));

create policy "School managers can delete announcements"
  on public.announcements for delete to authenticated
  using (public.is_school_manager(school_id));
