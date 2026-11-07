-- Leads (BONUS-1): landing-page applications. Inserts go through the API with
-- the service-role key; RLS is enabled with no policies so neither anon nor
-- authenticated clients can read or write the table directly.

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  institution_name text not null,
  contact_name text not null,
  city text not null,
  contact_role text not null,
  level text not null check (level in ('Inicial', 'Primario', 'Secundario', 'Terciario / Superior')),
  contact_channel text not null,
  student_count int not null check (student_count between 1 and 100000),
  comment text not null,
  status text not null default 'new' check (status in ('new', 'contacted', 'discarded')),
  privacy_accepted_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.leads enable row level security;
