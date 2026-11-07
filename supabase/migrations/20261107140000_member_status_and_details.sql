-- Users, teachers and guardians screens (M8, M9, M10).

-- A membership can be switched off without losing its history. The API
-- refuses every request made with an inactive one.
alter table public.memberships
  add column status text not null default 'active'
    check (status in ('active', 'inactive'));

-- Personal data of the school staff and the guardians, per school. It lives
-- apart from profiles for the same reason as student_details: everyone who
-- shares a school can read profiles. RLS is on with no policies, so only the
-- API (service role) reaches this table.
create table public.member_details (
  user_id uuid not null references public.profiles (id) on delete cascade,
  school_id uuid not null references public.schools (id) on delete cascade,
  dni text,
  phone text,
  training text,
  start_year integer,
  notes text,
  updated_at timestamptz not null default now(),
  primary key (user_id, school_id)
);

create unique index member_details_school_dni_key
  on public.member_details (school_id, dni)
  where dni is not null;

alter table public.member_details enable row level security;

-- How the guardian is related to the student, shown in the student file.
alter table public.guardian_links
  add column relationship text
    check (relationship in ('madre', 'padre', 'tutor', 'otro'));
