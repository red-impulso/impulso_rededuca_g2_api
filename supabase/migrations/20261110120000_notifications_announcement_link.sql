-- Link each "announcement" notification to its announcement so that
-- DELETE /announcements/:id can remove them and families stop seeing the
-- mistaken post. Rows cascade-delete with the announcement.
--
-- RLS: the notifications table already has it enabled and no policy changes
-- are needed — all deletes happen through the API's service-role client,
-- which bypasses RLS.

alter table public.notifications
  add column announcement_id uuid
  references public.announcements (id) on delete cascade;

create index notifications_announcement
  on public.notifications (announcement_id)
  where announcement_id is not null;

-- Best-effort backfill for notifications created before this column existed:
-- their title was built as 'Nuevo comunicado: {title}' from the announcement
-- that produced them, within the same school.
update public.notifications n
  set announcement_id = a.id
  from public.announcements a
  where n.type = 'announcement'
    and n.announcement_id is null
    and n.school_id = a.school_id
    and n.title = 'Nuevo comunicado: ' || a.title;
