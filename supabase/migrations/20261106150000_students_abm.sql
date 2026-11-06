-- Students ABM: profiles gets a DNI (unique per school) and an active/inactive
-- status so students can be given de baja without deleting their history
-- (grades and attendance keep referencing the profile).
alter table public.profiles
  add column dni text,
  add column status text not null default 'active'
    check (status in ('active', 'inactive'));

create unique index profiles_dni_unique_per_school
  on public.profiles (school_id, dni)
  where dni is not null;
