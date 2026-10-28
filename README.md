# Impulso_rededuca_g2_api

API (NestJS) de RedEduca, el "cerebro" del proyecto. Por ahora expone un endpoint de salud para comprobar que todo funciona.

## Requisitos

- Node.js 22.22.3 o superior dentro de la serie 22, 24.15.0 o superior dentro de la serie 24, o 26 o superior
- npm

## Instalar

```bash
npm ci
```

## Correr

```bash
npm run start:dev
```

La API queda en `http://localhost:3000` (se puede cambiar con la variable `PORT`).
Para verificar: `GET /health` → `200 { "status": "ok" }`.

## Probar

```bash
npm run lint
npm run build
npm test           # unitarios
npm run test:e2e   # end-to-end
```

## CI

GitHub Actions ejecuta lint, build, tests unitarios y e2e en cada push y pull request (`.github/workflows/ci.yml`). Si algo falla, el cambio se marca en rojo.
