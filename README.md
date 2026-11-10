# Impulso_rededuca_g2_api

API (NestJS) de RedEduca, el "cerebro" del proyecto. Por ahora expone un endpoint de salud para comprobar que todo funciona.

Stack: NestJS 12 + TypeScript (ESM), Vitest para tests, oxlint + Prettier para lint/format, y Supabase (Postgres) como base de datos.

## Requisitos

- Node.js 22.22.3 o superior dentro de la serie 22, 24.15.0 o superior dentro de la serie 24, o 26 o superior
- npm
- Opcional (base de datos local): [Supabase CLI](https://supabase.com/docs/guides/cli) y Docker

## Instalar

```bash
npm ci
```

## Variables de entorno

Copiar el archivo de ejemplo y ajustar los valores:

```bash
cp .env.example .env
```

| Variable                    | Descripción                                                           |
| --------------------------- | --------------------------------------------------------------------- |
| `PORT`                      | Puerto donde escucha la API (por defecto `3000`).                     |
| `SUPABASE_URL`              | URL del proyecto Supabase.                                            |
| `SUPABASE_ANON_KEY`         | Clave anónima (pública) de Supabase para el cliente.                  |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave `service_role` (privada) de Supabase; bypassa RLS. Solo server-side. |
| `SEED_PASSWORD`             | Contraseña de los usuarios demo; solo la usa `npm run seed`.            |
| `CORS_ORIGINS`              | Dominios extra que pueden llamar a la API desde el navegador, separados por coma (la URL de Vercel del grupo, con `https://` y sin `/` al final). `http://localhost:3000` siempre está permitido. |

El `.env` está en `.gitignore`: nunca subir claves reales al repositorio. La `service_role` abre toda la base: solo va en el `.env` local y en las variables de entorno del deploy (Render), nunca en el repo ni por chat.

## Autenticación

Todos los endpoints requieren `Authorization: Bearer <access_token>` de Supabase Auth, salvo los marcados como públicos (`GET /` y `GET /health`). El `AuthGuard` valida el token contra Supabase y deja `request.user = { id, email, phone }`.

- `GET /me` → `{ profile: { id, fullName, phone }, memberships: [{ id, institutionId, institutionName, role }] }`. Las membresías salen de la tabla `memberships` joineada con `schools` (`institutionId`/`institutionName` mapean a `school_id`/`schools.name`); un usuario puede tener varias.

Los endpoints de una institución se protegen con `MembershipGuard` (`@UseGuards(MembershipGuard)`, después del `AuthGuard` global): exigen el header `X-Institution-Id`, verifican que el usuario tenga membresía ahí (tabla `memberships`) y dejan `request.membership = { id, userId, institutionId, role }`, inyectable con `@CurrentMembership()`. Con `@Roles('admin', ...)` se restringe por rol. Sin header → 400; sin membresía o rol no permitido → 403. Si el usuario tiene varias membresías en la misma institución se usa la de mayor rango: `admin > director > teacher > guardian`.

- `GET /me/subjects` (rol `teacher`) → `[{ id, name, course: { id, year, division, shift } }]`: las materias que dicta en la institución.
- `GET /me/courses` (roles `teacher`, `admin`, `director`) → `[{ id, year, division, shift }]`: para `teacher`, los cursos donde tiene al menos una materia; para `admin` y `director`, todos los de la institución.
- `GET /me/students` (rol `guardian`) → `[{ id, firstName, lastName, course: { id, year, division } }]`: los estudiantes vinculados por `guardian_links`, con su curso en la institución.

### ABM de la institución

Endpoints para que la escuela cargue y edite sus datos, cursos y materias. Todos requieren `X-Institution-Id` y rol `admin` o `director`.

- `GET /institution` → `{ id, name, address, levels, code, phone, email, shift, modality }`.
- `PATCH /institution` → `{ name?, address?, levels?, code?, phone?, email?, shift?, modality? }` (al menos un campo; `address: null` la borra, `levels` es una lista de textos). Devuelve la institución actualizada.
- `GET /courses` → `[{ id, year, division, shift, schoolYear }]`, ordenados por ciclo lectivo, año y división.
- `POST /courses` → `{ year, division, shift, schoolYear }`. `shift` es `morning` | `afternoon` | `evening`. Duplicado (mismo año, división, turno y ciclo) → `409`.
- `PATCH /courses/:id` → mismo payload parcial. Curso de otra institución → `404`; duplicado → `409`.
- `DELETE /courses/:id` → `409` si el curso tiene alumnos inscriptos o materias cargadas (para no borrar notas/asistencias en cascada).
- `GET /subjects` → `[{ id, name, courseId, teacherMembershipId }]`.
- `POST /subjects` → `{ name, courseId, teacherMembershipId? }` (`teacherMembershipId` es el id de la membresía con rol `teacher` en la institución). Nombre duplicado en el curso → `409`.
- `PATCH /subjects/:id` → `{ name?, courseId?, teacherMembershipId? }` (`teacherMembershipId: null` desasigna al docente).
- `DELETE /subjects/:id`.
- `GET /guardians` (roles `admin`, `director`) → `[{ id, fullName }]`: los tutores activos de la institución, para vincularlos a un alumno.
- `GET /students/:id/guardians` → `[{ id, fullName, relationship, phone, email }]`: los tutores vinculados al alumno.
- `POST /students/:id/guardians` → `{ guardianMembershipId, relationship?, phone? }`. `relationship` es `madre` | `padre` | `tutor` | `otro`.
- `PATCH /students/:id/guardians/:guardianMembershipId` → `{ relationship?, phone? }`.
- `DELETE /students/:id/guardians/:guardianMembershipId`.
- `GET /teachers` → `[{ id, fullName, status, dni, subjects }]`.
- `GET /teachers/:id` → lo anterior más `{ email, phone, training, startYear, notes }`.
- `POST /teachers` → `{ fullName, email, temporaryPassword, dni?, phone?, training?, startYear?, notes? }`. DNI repetido en la institución → `409`.
- `PATCH /teachers/:id` → `{ fullName?, status?, dni?, phone?, training?, startYear?, notes? }` (al menos un campo).

### Usuarios

Solo rol `admin`.

- `GET /users` → `[{ id, userId, email, fullName, role, status }]`. `id` es el de la membresía.
- `POST /users` → `{ email, fullName, role, temporaryPassword }`.
- `PATCH /memberships/:id` → `{ fullName?, role?, status? }` (al menos un campo). `status` es `active` | `inactive`.
- `DELETE /memberships/:id`. Si la persona se queda sin roles en la institución, también se borran sus datos personales.

Una membresía inactiva no puede usar la API (`403`) y no aparece en `GET /me`. La institución siempre conserva un administrador activo: dejarla sin ninguno → `409`.

Los datos personales del personal y los tutores (DNI, teléfono, formación) van en `member_details`, por institución y sin políticas RLS: solo los lee la API.

### Alumnos

Solo roles `admin` y `director`.

- `GET /students?courseId&q` → `[{ id, firstName, lastName, dni, status, course: { id, year, division, shift } | null }]`, ordenados por apellido y nombre. `courseId` filtra por curso y `q` busca en nombre, apellido y DNI.
- `GET /students/:id` → la ficha: lo anterior más `{ birthDate, address, phone, email, updatedAt }`. El DNI y los datos personales viven en `student_details` (sin RLS, solo los lee la API).
- `POST /students` → `{ firstName, lastName, dni, email, courseId, password?, birthDate?, address?, phone? }`. Crea el usuario de auth (sin `password` genera una aleatoria) y lo inscribe en el curso. DNI repetido en la institución o email en uso → `409`.
- `PATCH /students/:id` → `{ firstName?, lastName?, dni?, courseId?, status?, birthDate?, address?, phone? }` (al menos un campo). `status: 'inactive'` da de baja al alumno: el perfil no se borra, conserva su historial y sale de las planillas de notas y asistencia. Un campo de datos personales en `null` lo borra.

### Notas

- `GET /grading-periods` → `[{ id, name, startDate, endDate }]`: los períodos de la institución.
- `GET /grades?subjectId&periodId` (rol `teacher`, solo sus materias) → `[{ student: { id, firstName, lastName }, value }]`: la planilla del curso de la materia, ordenada por apellido. Sin ambos parámetros → `400`.
- `PUT /grades` (rol `teacher`) → `{ subjectId, periodId, entries: [{ studentId, value }] }` → `{ saved }`. Las notas van de 1 a 10 con hasta dos decimales; `value: null` borra la nota. El lote se valida entero antes de escribir: un `studentId` que no pertenece al curso → `400` y no se guarda nada.
- `GET /students/:id/grades` → `[{ subject: { id, name }, period: { id, name }, value }]` ordenado por materia y período. `admin` y `director` lo ven siempre; `guardian` solo de sus hijos vinculados; `teacher` solo si tiene una materia en el curso del alumno. Otro caso → `403`.

### Asistencia

- `GET /attendance?courseId&date` (roles `teacher`, `admin`, `director`) → `[{ student: { id, firstName, lastName }, status }]` con `status` `null` si no se tomó lista. La fecha no puede ser futura ni inválida → `400`. Un `teacher` solo accede a cursos donde tiene una materia.
- `PUT /attendance` (mismos roles) → `{ courseId, date, entries: [{ studentId, status }] }` → `{ saved }`. `status` es `present` | `absent` | `late` | `justified`.
- `GET /students/:id/attendance` → `{ records: [{ date, status }], summary: { present, absent, late, justified, percentage } }`. `percentage` es `(present + late) / (present + late + absent)` — `justified` no cuenta — y `null` si no hay días computables. Mismas reglas de visibilidad que las notas.

### Comunicados

- `POST /announcements` (roles `admin`, `director`, `teacher`) → `{ scope: 'institution' | 'course' | 'student', courseId?, studentId?, title, body }`. `course` exige `courseId`, `student` exige `studentId` y `institution` no admite ninguno → `400` si no coincide. Un `teacher` solo puede publicar con `scope: 'course'` en cursos donde tiene materia → `403` si no.
- `GET /announcements` → `[{ id, scope, courseId, studentId, title, body, createdAt, authorName, courseLabel }]`, más nuevos primero. `admin` y `director` ven todos; los demás roles ven los de institución más los de sus cursos (docentes) o hijos (tutores).

### Notificaciones

Se generan solas cuando se cargan notas, se toma asistencia o se publica un comunicado (`type`: `grade` | `attendance` | `announcement`), y les llegan a los tutores y docentes a quienes corresponde. Requieren membresía pero no un rol particular.

- `GET /notifications` → las últimas 50: `[{ id, type, title, body, readAt, createdAt }]`.
- `GET /notifications/unread-count` → `{ count }`.
- `POST /notifications/:id/read` → la notificación marcada como leída. De otro usuario → `404`.
- `POST /notifications/read-all` → `{ read }`: cantidad marcada.

### Tablero

- `GET /dashboard` (roles `admin`, `director`) → `{ students, courses, teachers, attendanceAverage, lowAttendance, gradeAverages }`. `attendanceAverage` es el porcentaje de asistencia de la institución (`null` sin registros); `lowAttendance` lista `[{ student, course, percentage }]` con los alumnos por debajo del 85 %, de menor a mayor; `gradeAverages` lista `[{ subject, course, average }]` con el promedio por materia (`null` sin notas cargadas).

## Postulaciones de la landing

`POST /leads` es público (sin token) y recibe el formulario de la landing del grupo 2:

```json
{
  "institutionName": "Escuela 12",
  "institutionType": "Institución educativa pública",
  "city": "Perico",
  "studentCount": 320,
  "contactName": "Ana López",
  "phone": "388 400-0000",
  "email": "ana@escuela.edu.ar",
  "comment": "Opcional, hasta 600 caracteres",
  "website": ""
}
```

- `institutionType`: `Institución educativa pública` | `Institución educativa privada` | `Institución de gestión social o cooperativa` | `Otra`.
- `studentCount`: entero de 1 a 100000. `phone`: entre 8 y 15 dígitos.
- `website` es una trampa para robots: el formulario lo oculta. Si viene lleno, la API responde `201` sin guardar nada.
- Datos inválidos → `400`. Más de 5 envíos por minuto desde la misma IP → `429`.
- La landing publicada (`https://proyecto-red-educa-grupo-2.vercel.app`) siempre está permitida por CORS.

Solo un administrador puede ver las postulaciones con `GET /leads?status=new|contacted|discarded`, y marcarlas con `PATCH /leads/:id` → `{ status }`.

## Correr

```bash
npm run start:dev      # desarrollo con watch
npm run start:debug    # desarrollo con inspector de Node
npm run start:prod     # producción: requiere `npm run build` antes
```

La API queda en `http://localhost:3000` (se puede cambiar con la variable `PORT`).
Para verificar: `GET /health` → `200 { "status": "ok" }`.

## Base de datos (Supabase)

El CLI de Supabase está instalado como devDependency; se invoca con:

```bash
npm run supabase -- <comando>   # ej: npm run supabase -- db push --db-url "$SUPABASE_DB_URL"
```

Los comandos que levantan el stack local (`start`, `status`, `stop`, `db reset`) requieren Docker Desktop instalado y corriendo. Los que apuntan a la base remota (`link`, `db push --db-url`, `projects list`) funcionan sin Docker.

El esquema vive como migraciones SQL en `supabase/migrations/`. Incluye las tablas `schools`, `profiles`, `memberships`, `courses`, `subjects` y `enrollments`, con políticas RLS que limitan cada usuario a los datos de sus escuelas (un usuario puede pertenecer a varias vía `memberships`).

- **Crear una migración nueva:** `supabase migration new <nombre>` (o agregar un archivo `YYYYMMDDHHMMSS_descripcion.sql` en `supabase/migrations/`).
- **Desarrollo local:** `supabase start` levanta Postgres + Auth + Studio en Docker; `supabase db reset` recrea la base aplicando todas las migraciones.
- **Producción:** al hacer push a `main`, el workflow `.github/workflows/migrate.yml` ejecuta `supabase db push` automáticamente contra la base configurada en el secreto `SUPABASE_DB_URL` del repo. No aplicar migraciones a mano en producción: agregar el archivo SQL y hacer merge a `main`.

## Seed de demo

`npm run seed` (`scripts/seed.ts`) carga una escuela de mentira — "Escuela Demo Perico" — para probar y mostrar el sistema sin datos reales: un admin (`admin@demo.rededuca`), dos docentes (`docente1@`, `docente2@`), seis tutores (`tutor1@` a `tutor6@`), 20 alumnos repartidos en dos cursos (1.º A y 2.º A, mañana, 2026), 4 materias y el período "1.er trimestre". `tutor1` tiene 3 hijos vinculados.

Requiere `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` y `SEED_PASSWORD` (contraseña compartida de todos los usuarios demo — elegila vos, no va en el repo) en `.env` o en el entorno. Es idempotente: borra la institución demo y la recrea; los usuarios se reutilizan si ya existen.

## Probar

```bash
npm run lint           # oxlint (type-aware) sobre src/ y test/
npm run format         # prettier --write sobre src/ y test/
npm run build          # compila a dist/
npm test               # unitarios (vitest run)
npm run test:watch     # unitarios en modo watch
npm run test:cov       # unitarios con coverage (v8)
npm run test:e2e       # end-to-end (vitest.config.e2e.ts)
```

## CI

GitHub Actions ejecuta lint, build, tests unitarios y e2e en cada push y pull request (`.github/workflows/ci.yml`). Si algo falla, el cambio se marca en rojo.

Además, cada push a `main` aplica las migraciones pendientes a la base de datos (`.github/workflows/migrate.yml`).

## Estructura

```
src/
  main.ts                  # bootstrap de NestJS (carga .env si existe)
  app.module.ts            # módulo raíz (guard global + EventEmitterModule)
  auth/                    # AuthGuard global (Supabase Auth), MembershipGuard,
                           #   @Public(), @Roles() y @CurrentMembership()
  supabase/                # cliente admin de Supabase (service_role)
  me/                      # GET /me y los endpoints propios de cada rol
  health/                  # módulo de health check (GET /health)
  modules/                 # un módulo por dominio (controller + service + dto):
                           #   institution, students, teachers, guardians, users,
                           #   grades, attendance, announcements, notifications,
                           #   dashboard y leads
supabase/
  config.toml              # config del proyecto Supabase local
  migrations/              # migraciones SQL de la base
test/                      # tests e2e
```
