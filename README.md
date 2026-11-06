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

- `PATCH /institution` → `{ name?, address?, levels? }` (al menos un campo; `address: null` la borra, `levels` es una lista de textos). Devuelve la institución actualizada.
- `GET /courses` → `[{ id, year, division, shift, schoolYear }]`, ordenados por ciclo lectivo, año y división.
- `POST /courses` → `{ year, division, shift, schoolYear }`. `shift` es `morning` | `afternoon` | `evening`. Duplicado (mismo año, división, turno y ciclo) → `409`.
- `PATCH /courses/:id` → mismo payload parcial. Curso de otra institución → `404`; duplicado → `409`.
- `DELETE /courses/:id` → `409` si el curso tiene alumnos inscriptos o materias cargadas (para no borrar notas/asistencias en cascada).
- `GET /subjects` → `[{ id, name, courseId, teacherMembershipId }]`.
- `POST /subjects` → `{ name, courseId, teacherMembershipId? }` (`teacherMembershipId` es el id de la membresía con rol `teacher` en la institución). Nombre duplicado en el curso → `409`.
- `PATCH /subjects/:id` → `{ name?, courseId?, teacherMembershipId? }` (`teacherMembershipId: null` desasigna al docente).
- `DELETE /subjects/:id`.

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
  auth/                    # AuthGuard global (Supabase Auth) + decorador @Public()
  supabase/                # cliente admin de Supabase (service_role)
  me/                      # GET /me: perfil y membresías del usuario
  health/                  # módulo de health check (GET /health)
supabase/
  config.toml              # config del proyecto Supabase local
  migrations/              # migraciones SQL de la base
test/                      # tests e2e
```
