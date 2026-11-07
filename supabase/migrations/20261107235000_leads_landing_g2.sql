-- Leads follow the group 2 landing form: institution type, phone and email
-- instead of role, level and a single contact channel, and an optional
-- message. The form has no privacy checkbox, so no consent date is stored.
-- The table is still empty: the new not-null columns need no backfill.

alter table public.leads
  drop column contact_role,
  drop column level,
  drop column contact_channel,
  drop column privacy_accepted_at,
  add column institution_type text not null check (
    institution_type in (
      'Institución educativa pública',
      'Institución educativa privada',
      'Institución de gestión social o cooperativa',
      'Otra'
    )
  ),
  add column phone text not null,
  add column email text not null,
  alter column comment drop not null;
