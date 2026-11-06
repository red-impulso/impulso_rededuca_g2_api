-- Institution screen (M6-2): identification and contact data shown in the
-- UX/UI design. All optional, so existing schools keep working.

alter table public.schools
  add column code text,
  add column phone text,
  add column email text,
  add column shift text,
  add column modality text;
