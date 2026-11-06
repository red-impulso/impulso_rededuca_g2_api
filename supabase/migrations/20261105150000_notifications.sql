-- In-app notifications (M4-1): one row per affected guardian when a grade is
-- saved, a kid is absent or an announcement is posted.

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null check (type in ('grade', 'attendance', 'announcement')),
  title text not null check (length(btrim(title)) > 0),
  body text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_inbox
  on public.notifications (user_id, school_id, created_at desc);

alter table public.notifications enable row level security;

create policy "Users can view their own notifications"
  on public.notifications for select to authenticated
  using (user_id = auth.uid());

create policy "School members can create notifications"
  on public.notifications for insert to authenticated
  with check (public.is_member(school_id));

create policy "Users can mark their own notifications as read"
  on public.notifications for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
