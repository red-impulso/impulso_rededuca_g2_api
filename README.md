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

El `.env` está en `.gitignore`: nunca subir claves reales al repositorio. La `service_role` abre toda la base: solo va en el `.env` local y en las variables de entorno del deploy (Render), nunca en el repo ni por chat.

## Autenticación

Todos los endpoints requieren `Authorization: Bearer <access_token>` de Supabase Auth, salvo los marcados como públicos (`GET /` y `GET /health`). El `AuthGuard` valida el token contra Supabase y deja `request.user = { id, email, phone }`.

- `GET /me` → `{ profile: { id, fullName, phone }, memberships: [{ id, institutionId, institutionName, role }] }`. Las membresías se derivan de `profiles.school_id` + `schools` (`institutionId`/`institutionName` mapean a `school_id`/`schools.name`).

## Correr

```bash
npm run start:dev      # desarrollo con watch
npm run start:debug    # desarrollo con inspector de Node
npm run start:prod     # producción: requiere `npm run build` antes
```

La API queda en `http://localhost:3000` (se puede cambiar con la variable `PORT`).
Para verificar: `GET /health` → `200 { "status": "ok" }`.

## Base de datos (Supabase)

El esquema vive como migraciones SQL en `supabase/migrations/`. Incluye las tablas `schools`, `profiles`, `courses`, `subjects` y `enrollments`, con políticas RLS que limitan cada usuario a los datos de su escuela.

- **Crear una migración nueva:** `supabase migration new <nombre>` (o agregar un archivo `YYYYMMDDHHMMSS_descripcion.sql` en `supabase/migrations/`).
- **Desarrollo local:** `supabase start` levanta Postgres + Auth + Studio en Docker; `supabase db reset` recrea la base aplicando todas las migraciones.
- **Producción:** al hacer push a `main`, el workflow `.github/workflows/migrate.yml` ejecuta `supabase db push` automáticamente contra la base configurada en el secreto `SUPABASE_DB_URL` del repo. No aplicar migraciones a mano en producción: agregar el archivo SQL y hacer merge a `main`.

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
