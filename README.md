# Tinder de productos

App de revision tipo swipe para catalogos de productos.

## Guardado remoto en Vercel

La app usa estas APIs serverless:

- `GET/PUT /api/session-state` para guardar decisiones.
- `GET /api/exports` para obtener JSON remotos.
- `GET /api/health` para validar conexion.

### 1) Crear tabla en Supabase

Ejecuta el SQL:

- [`supabase/review_states.sql`](./supabase/review_states.sql)

### 2) Variables de entorno en Vercel

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### 3) Compartir link con reviewer fijo

Comparte con `session` y `reviewer`:

`https://tu-app.vercel.app/?session=herramientas-bogota&reviewer=kevin`

### 4) Descargar JSON remoto

Aceptados:

`https://tu-app.vercel.app/api/exports?session=herramientas-bogota&reviewer=kevin&type=keep&download=1`

Rechazados:

`https://tu-app.vercel.app/api/exports?session=herramientas-bogota&reviewer=kevin&type=drop&download=1`

## Desarrollo local

```bash
npm install
npm run dev
```
