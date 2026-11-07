-- The DNI of a minor moves out of profiles, which everyone sharing a school can
-- read, into student_details, which only the API reaches (RLS with no policies).
alter table public.student_details
  add column school_id uuid references public.schools (id) on delete cascade,
  add column dni text;

insert into public.student_details (student_id, school_id, dni)
select id, school_id, dni
from public.profiles
where dni is not null
on conflict (student_id) do update
  set school_id = excluded.school_id, dni = excluded.dni;

update public.student_details d
set school_id = p.school_id
from public.profiles p
where p.id = d.student_id and d.school_id is null;

alter table public.student_details alter column school_id set not null;

create unique index student_details_dni_unique_per_school
  on public.student_details (school_id, dni)
  where dni is not null;

-- Also drops the profiles_dni_unique_per_school index.
alter table public.profiles drop column dni;
