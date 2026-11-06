-- Institution profile fields editable via PATCH /institution: the school
-- address and the educational levels it offers (e.g. inicial, primaria).

alter table public.schools
  add column address text,
  add column levels text[] not null default '{}';
