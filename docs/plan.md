# [NOMBRE] — Plan, modelo de datos y decisiones (Fase 2)

**Fecha:** 12-nov-2026 · **Estado:** decisiones provisionales. Por indicación del usuario ("hazlo completo") se avanzó con las recomendaciones del inventario funcional. Cada decisión marcada **[PROV]** se puede revertir.

## 1. Stack
| Capa | Elección | Motivo |
|---|---|---|
| Web | Next.js 15 (App Router) + TypeScript + Tailwind | Especificado. |
| Base de datos | Supabase (Postgres 16, Auth, RLS, Vault) | Especificado. Reglas críticas en funciones SQL transaccionales. |
| Pruebas BD | Vitest + Postgres embebido (`embedded-postgres`) | No hay Docker en el equipo. Postgres real, con concurrencia y RLS reales. |
| Pruebas UI | Playwright (fase 6+) | Flujos del POS con teclado. |

## 2. Decisiones

| # | Decisión | Origen |
|---|---|---|
| D1 | Una sola razón social; serie de folios por sucursal y tipo de documento. | Chrome (P1) **[PROV]** |
| D2 | Cantidades en **numeric(18,6)**, factores en **numeric(18,8)**, dinero en numeric(14,2). | P39 **[PROV]**: equivalencias reales de 6 decimales (0.023816 m²/pieza). |
| D3 | La unidad base es una unidad de venta más (factor 1). Cada unidad tiene **precio propio por lista**. | Especificación |
| D4 | "Solo unidades completas" (`permite_fraccion = false`): la cantidad debe ser entera en la unidad elegida. La calculadora redondea hacia arriba. | Especificación + P7 **[PROV]** |
| D5 | **Costo con existencia negativa:** se vende al costo promedio (o al último costo si el promedio es 0). Lo faltante queda en `costo_pendiente`. Al llegar la entrada se corrige en FIFO y queda en `ajustes_costo_venta` (diferencia por partida). El promedio solo pondera la existencia positiva previa. | Especificación §7.2 |
| D6 | Toda venta es una **nota de venta**; la factura se genera desde una o varias ventas. | P31 **[PROV]** |
| D7 | El cobro se registra al momento de la venta (efectivo, transferencia, tarjeta de débito o de crédito, con referencia opcional). La conciliación es en el **corte semanal del sábado**. Crédito solo para clientes con límite; excederlo requiere `otorgar_credito`. | Confirmado 12-nov |
| D8 | Pedidos de Bind fuera de alcance; se usan apartados (fase 7). | P22 |
| D9 | Disponible = existencia − apartado. Lo pendiente por entregar ya salió de la existencia; el conteo físico lo suma al "esperado en anaquel". | P14 **[PROV]** |
| D10 | Traspasos: enviado (sale del origen) → en tránsito (opcional) → recibido (entra al destino). Se cancelan antes de recibir. Recepción con cantidad recibida ≤ enviada. | P17/P18 **[PROV]** |
| D11 | Existencia inicial = conteo físico del corte u hoja de Google, **no** las existencias de Bind. | P40 (respondida) |
| D12 | Hoja de Google: será una **integración configurable dentro del sistema**: publicar existencias cada N minutos (modo A) e importar conteos o carga inicial como ajustes con vista previa (modo B). Sin edición en ambos sentidos. **Se pospone** a una fase posterior, por indicación del usuario (12-nov-2026). | P47 |
| D13 | Usuarios **por tienda** (5 usuarios); la tienda principal con más permisos. Rol `contador` preparado para más adelante. | Confirmado 12-nov |
| D14 | Vigencia de cotización por defecto: 15 días. "Vencida" se calcula, no se guarda. | P20 **[PROV]** |
| D15 | Los precios de lista **incluyen IVA**. La nota muestra el total y el IVA se desglosa al facturar. | Confirmado 12-nov |
| D16 | Apartados: anticipo mínimo **30 %**; **sin plazo máximo**, solo aviso a los 30 días; precio congelado al apartar; reservan sin descontar y descuentan al liquidarse como venta; al cancelar se retiene un **% configurable (10 % inicial, pendiente de definir por el negocio)** y se devuelve el resto. | Confirmado 12-nov (% por definir) |
| D17 | La interfaz conserva la **estructura y el flujo** que el personal ya conoce (menú por módulos, Capturar venta, Pagos, totales a la derecha), con nombre y diseño propios. | Usuario 12-nov |

## 3. Modelo de datos (implementado en `supabase/migrations`)

```
empresa ─┐
sucursales ──< almacenes ──< existencias >── productos ──< unidades_venta ──< precios >── listas_precios
    │            │   (cantidad, apartado)       │                (factor, clave SAT, código barras)
    │            └──< movimientos (kardex inmutable, saldo corrido)
    ├──< cajas
    ├──< series (folio consecutivo por tipo)
    └──< usuario_sucursales >── perfiles (rol) ──< usuario_permisos ; rol_permisos

clientes ──< cotizaciones ──< cotizacion_partidas
    │             └─(venta_id, una sola conversión)
    └──< ventas ──< venta_partidas (cantidad, cantidad_base, cantidad_entregada, costo, sin_existencia)
            ├──< venta_pagos
            └──< entregas ──< entrega_partidas
entradas ──< entrada_partidas      traspasos ──< traspaso_partidas      ajustes ──< ajuste_partidas
costo_pendiente → ajustes_costo_venta          bitacora          sat_catalogo
```

### Funciones transaccionales (RPC)
| Función | Qué hace |
|---|---|
| `confirmar_venta(p)` | Una transacción: idempotencia (bloqueo asesor + clave única), validación de sucursal/almacén/precio/descuento/crédito, bloqueo ordenado de existencias, folio consecutivo, conversión a unidad base, venta + partidas + pagos, movimientos, avisos "vendida sin existencia" y costo pendiente, cierre de la cotización. |
| `cancelar_venta(id, motivo)` | Movimiento inverso exacto de lo descontado; bloquea si está facturada. |
| `registrar_entrega(p)` | Entrega parcial con folio; no mueve inventario; nunca más de lo vendido. |
| `guardar_cotizacion(p)` / `preparar_conversion(id)` | Cotización con folio; conversión con avisos de cambio de precio y falta de existencia. |
| `registrar_entrada(p)` | Entrada con costo, costo promedio y corrección FIFO de costo pendiente. |
| `enviar_traspaso` / `marcar_traspaso_en_transito` / `recibir_traspaso` / `cancelar_traspaso` | Traspasos con estados. |
| `registrar_ajuste(p)` | Ajustes con permiso y motivo; también la carga inicial. |
| `calcular_unidades(unidad, cantidad_base)` | Calculadora m² → cajas completas. |

### Seguridad
- RLS en todas las tablas (`force row level security`).
- Lectura de catálogos y existencias para todos. Documentos solo de las sucursales propias.
- Sin permisos de escritura directa en tablas transaccionales: solo mediante funciones `security definer` que validan `opera_sucursal`, `opera_almacen` y `tiene_permiso`.
- Bitácora automática de perfiles, permisos, precios y crédito de clientes, y explícita en cancelaciones y ajustes.

## 4. Fases y estado
| Fase | Estado |
|---|---|
| 1. Revisión de Bind y documento funcional | ✅ `referencia/inventario-funcional.md` |
| 2. Plan y modelo de datos | ✅ este documento |
| 3. Autenticación, sucursales y permisos | 🟡 BD + RLS listas; pantallas de inicio de sesión pendientes |
| 4. Productos, unidades y clientes | 🟡 BD lista; pantallas e importación Excel pendientes |
| 5. Inventarios y kardex | 🟡 BD lista (entradas, traspasos, ajustes); conteo físico y hoja de Google pendientes |
| 6. Cotizaciones, POS y caja | 🟡 BD de cotización y venta lista; POS, caja y corte pendientes |
| 7. Crédito, apartados y entregas | 🟡 Entregas listas; abonos y apartados pendientes |
| 8–12 | ⏳ |

## 5. Supuestos abiertos
Ver preguntas P3–P50 en `referencia/inventario-funcional.md`. Las que más afectan lo construido: **P39** (decimales), **P42** (cobro inmediato), **P43** (IVA en precios), **P44** (usuarios por persona), **P47–P50** (hoja de Google y su enlace).
