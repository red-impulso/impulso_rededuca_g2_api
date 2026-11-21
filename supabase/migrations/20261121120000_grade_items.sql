-- Instancias de nota de cada período (prototipo de calificaciones del
-- informe de diseño): TP 1, TP 2, Parcial 1, Parcial 2 y Final.
-- grades sigue siendo la nota del período: la API la guarda como el
-- promedio de las instancias cargadas, así el tablero, las familias y las
-- notificaciones siguen leyendo una nota por materia y período.

create table public.grade_items (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles (id) on delete cascade,
  subject_id uuid not null references public.subjects (id) on delete cascade,
  period_id uuid not null references public.periods (id) on delete cascade,
  kind text not null check (kind in ('tp1', 'tp2', 'parcial1', 'parcial2', 'final')),
  value numeric(4,2) not null check (value between 1 and 10),
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, subject_id, period_id, kind)
);

create index grade_items_subject_period_idx
  on public.grade_items (subject_id, period_id);

alter table public.grade_items enable row level security;

create policy "Members can view grade items in their school"
  on public.grade_items for select to authenticated
  using (exists (
    select 1
    from public.subjects
    join public.courses on courses.id = subjects.course_id
    where subjects.id = grade_items.subject_id
      and public.is_member(courses.school_id)
  ));

-- El docente de la materia (o la administración) carga, corrige y borra
-- sus instancias.
create policy "Subject teachers and school admins can record grade items"
  on public.grade_items for insert to authenticated
  with check (exists (
    select 1
    from public.subjects
    join public.courses on courses.id = subjects.course_id
    where subjects.id = grade_items.subject_id
      and (
        subjects.teacher_id = auth.uid()
        or public.is_school_admin(courses.school_id)
      )
  ));

create policy "Subject teachers and school admins can update grade items"
  on public.grade_items for update to authenticated
  using (exists (
    select 1
    from public.subjects
    join public.courses on courses.id = subjects.course_id
    where subjects.id = grade_items.subject_id
      and (
        subjects.teacher_id = auth.uid()
        or public.is_school_admin(courses.school_id)
      )
  ))
  with check (exists (
    select 1
    from public.subjects
    join public.courses on courses.id = subjects.course_id
    where subjects.id = grade_items.subject_id
      and (
        subjects.teacher_id = auth.uid()
        or public.is_school_admin(courses.school_id)
      )
  ));

create policy "Subject teachers and school admins can delete grade items"
  on public.grade_items for delete to authenticated
  using (exists (
    select 1
    from public.subjects
    join public.courses on courses.id = subjects.course_id
    where subjects.id = grade_items.subject_id
      and (
        subjects.teacher_id = auth.uid()
        or public.is_school_admin(courses.school_id)
      )
  ));
