-- Alertas tempranas: un alumno está "en riesgo" si su asistencia es menor al
-- 75 % (con al menos 3 días cargados) o si una materia tiene promedio menor
-- a 6. La API (modules/alerts) avisa a los tutores y a la dirección la primera
-- vez que pasa, y guarda acá que ya avisó para no repetir el aviso en cada
-- guardado. Cuando el alumno deja de estar en riesgo se borra la fila, así
-- una recaída vuelve a avisar.
--
-- RLS: activada y sin políticas. Solo la lee y escribe la API con la clave de
-- servicio; nadie la ve desde la web.

create table public.risk_alerts (
  school_id uuid not null references public.schools (id) on delete cascade,
  student_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (school_id, student_id)
);

alter table public.risk_alerts enable row level security;

-- Nuevo tipo de aviso: 'risk'.
alter table public.notifications
  drop constraint notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check
  check (type in ('grade', 'attendance', 'announcement', 'risk'));
