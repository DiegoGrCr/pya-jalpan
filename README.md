# [NOMBRE]

Sistema de inventarios, cotizaciones, punto de venta y facturación electrónica (CFDI 4.0) multisucursal. Reemplaza a Bind ERP.

- Documento funcional: [referencia/inventario-funcional.md](referencia/inventario-funcional.md)
- Plan, modelo de datos y decisiones: [docs/plan.md](docs/plan.md)
- Esquema de base de datos: [supabase/migrations](supabase/migrations)

## Requisitos
- Node.js 20 o superior
- Un proyecto de Supabase (para usar la aplicación). Las pruebas **no** lo necesitan: usan un Postgres embebido.

## Pruebas
```bash
npm install
npm test          # unidades + base de datos (Postgres real embebido, sin Docker)
```

## Ejecutar la aplicación
1. Crea un proyecto en Supabase y aplica las migraciones de `supabase/migrations` en orden (SQL Editor o `supabase db push`).
2. Copia `.env.example` a `.env.local` y llena `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
3. Crea tu usuario en Authentication > Users > Add user (con "Auto Confirm User").
4. Edita y ejecuta `supabase/seed/01_configuracion_inicial.sql` (sucursales, almacenes, cajas, series, lista y administrador).
5. Opcional: `supabase/seed/02_datos_demo.sql` (productos ficticios con existencia, para probar el POS).
6. `npm run dev` y abre http://localhost:3000

## Reglas clave
- El inventario se descuenta al **confirmar** la venta, en una sola transacción (`confirmar_venta`).
- La existencia nunca se edita directamente: todo cambio es un movimiento del kardex, que es inmutable.
- Las cantidades se guardan en unidad base (`numeric(18,6)`); el dinero en `numeric(14,2)`.
- Los permisos se aplican en la base de datos (RLS + funciones), no solo en la interfaz.
