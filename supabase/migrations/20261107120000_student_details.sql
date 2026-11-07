-- Student file (M7-2): personal data shown in the UX/UI design.
-- It lives apart from profiles on purpose: everyone who shares a school can
-- read profiles, and the address or phone of a minor must not be visible to
-- other families. RLS is on with no policies, so only the API (service role)
-- reaches this table, and the API only exposes it to admin and director.
create table public.student_details (
  student_id uuid primary key references public.profiles (id) on delete cascade,
  birth_date date,
  address text,
  phone text,
  updated_at timestamptz not null default now()
);

alter table public.student_details enable row level security;
