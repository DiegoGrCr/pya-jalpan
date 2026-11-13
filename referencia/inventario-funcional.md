# Inventario funcional — sistema de reemplazo de Bind ERP

**Versión:** 0.2 (con revisión de Bind en Chrome) · **Fecha:** 12 de noviembre de 2026
**Nombre del sistema:** `[NOMBRE]` (provisional; configurable en un solo lugar)

## 0. Fuentes y alcance

| Fuente | Estado |
|---|---|
| Carpeta `/referencia` (documentos impresos) | **No existe**: el proyecto empieza desde cero. |
| Bind ERP en Chrome (con tu sesión) | **Revisado en solo lectura** el 12-nov-2026: productos, captura de venta, cotizaciones, clientes, almacenes, existencias, ajustes, cuentas por cobrar, pagos, cuentas de caja, pedidos, notas de crédito, estado de cuenta y reportes. **Sin acceso con tu usuario** (redirigen al inicio de sesión): Configuración, Punto de Venta, Transferencias y Ajuste múltiple. No se guardó, canceló ni timbró nada. |
| Centro de ayuda público de Bind (`intercom.help/bindayuda`) | Revisado: ~70 artículos de Configuración, Compras/Productos, Inventarios, Ventas, Finanzas, Créditos y Reportes. |
| Tu especificación | Fuente principal. Tiene prioridad sobre Bind cuando difieren. |

**Cómo leer este documento**

- Cada pantalla indica **qué hace en Bind** (redactado con mis palabras, sin copiar textos) y **qué hará [NOMBRE]**.
- Marcas:
  - **[B]**: confirmado en la ayuda pública de Bind.
  - **[E]**: viene de tu especificación.
  - **[?]**: no aparece en ninguna fuente; es una **pregunta** (sección 14). No lo implemento hasta que respondas.
  - **[CHROME]**: conviene confirmarlo en tu Bind real cuando tenga acceso al navegador (columnas exactas, opciones de listas, formatos impresos).
- Todos los ejemplos son ficticios.
- **Fuera de alcance** (en Bind sí existen): contabilidad y pólizas, nómina, producción y fórmulas, Carta Porte, comercio exterior, marketplaces (Mercado Libre, Amazon, Shopify, Tiendanube), conciliación bancaria, gastos, órdenes de compra y cuentas por pagar. **[?]** Confirma que ninguno se usa hoy.

---

## 0.1 Hallazgos en tu Bind (revisión en Chrome)

Marca **[C]** = observado en tu cuenta. Sin nombres de clientes ni importes.

**Estructura**
- **[C]** Una sola razón social (persona física), visible en el encabezado de los documentos.
- **[C]** 4 sucursales y 5 almacenes. Una sucursal tiene 2 almacenes. Un almacén ("General") está marcado **multisucursal**. El formulario de producto muestra un 6.º almacén que no aparece en la lista (probablemente dado de baja).
- **[C]** Usuarios: **una cuenta por tienda** más un administrador general, no una por persona. Estas cuentas aparecen como "vendedor", "capturó" y "cobrador".
- **[C]** Una sola lista de precios ("A").
- **[C]** Series en uso: 3 de facturas y 4 de remisiones, por sucursal, con prefijo de letras + consecutivo. Las cotizaciones también tienen serie propia.
- **[C]** Cuentas de cobro: 2 cuentas de tipo caja (una por punto físico) y ninguna cuenta bancaria registrada.

**Productos y unidades**
- **[C]** Unidad base típica: **M2**. Unidades alternas: **CAJA** (ej. 0.99 m²) y **PIEZA** (ej. **0.023816 m²**, con 6 decimales), ambas de venta y compra, con su clave SAT (XBX caja, H87 pieza).
- **[C]** En la venta, la unidad por defecto es CAJA. El precio de caja o pieza es el **precio por m² × equivalencia** (6 decimales). **No hay precio propio por unidad.**
- **[C]** La existencia en la partida se muestra convertida a la unidad elegida, **sin redondeo** (ej. "-3.0303030303030303" cajas).
- **[C]** Categoría nivel 1 = **marca** del fabricante. Hay 3 niveles de categoría.
- **[C]** El producto revisado tiene clave SAT de producto **01010101 ("No existe en el catálogo")**: las claves SAT no están bien capturadas.
- **[C]** "Tipo de compras": regular, pedimento, lote, lote y caducidad, lote y pedimento, o lote + pedimento + caducidad.

**Inventario**
- **[C]** Existencias con hasta 5 decimales y **muchas existencias negativas** por almacén. El total de un almacén es negativo.
- **[C]** La vista de existencias por almacén tiene las columnas código, nombre, SKU, ubicación, valor, inventario, pedidos, compras y balance (= inventario − pedidos + compras), con fila de total.
- **[C]** Ajustes de inventario: casi sin uso.

**Ventas y cobranza**
- **[C]** La operación diaria se captura en **"Capturar Venta" como remisión**, casi siempre a "Público en general", con **método PPD, forma de pago "Por definir" e IVA 0%**.
- **[C]** El cobro se registra **después**, como "pago de cliente" contra la remisión, en la cuenta de caja de la tienda. Formas vistas: efectivo y tarjeta de crédito. Muchas remisiones del día siguen con el total pendiente.
- **[C]** No se ve uso del Punto de Venta de Bind (además, tu usuario no tiene acceso).
- **[C]** Pedidos: prácticamente sin uso. Notas de crédito: ninguna en el periodo consultado. Hay pocos clientes con saldo en el estado de cuenta.
- **[C]** Cotizaciones: sí se usan. Estatus visto: "Activa". La vigencia viene vacía por defecto.
- **[C]** Acciones del detalle de remisión con tu usuario: registrar pago, nota de crédito, copiar, subir XML, exportar partidas, correo, PDF, **hoja de salida** e **imprimir ticket**. No aparece "Cancelar" (sin permiso).

**Reportes**
- **[C]** Histórico de ventas: los filtros y la agrupación coinciden con la ayuda. Columnas: #, fecha, cliente, producto/concepto, cantidad, costo, utilidad, subtotal, descuento, IVA, IEPS, total, pagos, N.C., saldo y estatus.
- **[C]** Reportes de inventario: inventarios históricos, puntos de reorden y movimientos de producto.
- **[C]** Reportes de ventas: dashboard, histórico, tendencias, exportar facturas y comisiones.

**Consecuencias para el diseño**
1. **Precisión del factor.** Una pieza = 0.023816 m², y con `numeric(14,4)` se perdería precisión: 42 piezas son 1.000272 m², no 1.0003. Propuesta: guardar el **factor en `numeric(18,8)`** y las **cantidades en unidad base en `numeric(18,6)`**. El dinero se queda en `numeric(14,2)`. Esto cambia tu especificación, así que necesito tu visto bueno (P39).
2. **Migración de existencias negativas.** Hay que decidir si se cargan tal cual o se corrigen con el conteo físico del corte (P40).
3. **Claves SAT.** Antes de facturar desde [NOMBRE] hay que corregir la clave de producto/servicio. La importación marcará los productos con 01010101 (P41).
4. **Flujo de cobro.** Hoy se vende y se cobra después. [NOMBRE] propone cobrar en el mismo paso (POS) y dejar como crédito solo lo que no se paga (P42).
5. **IVA en 0% en remisiones** (P43).
6. **Usuarios por persona.** La bitácora y los permisos necesitan usuarios individuales (P44).

---

## 1. Configuración

### 1.1 Empresa y razón social
- **[B]** Bind guarda los datos fiscales de la empresa y el CSD en el perfil de empresa. Una sucursal puede tener su propio CSD y facturar con otra razón social o RFC; si no lo tiene, usa el de la empresa.
- **[E]** El CSD y su contraseña van cifrados (Vault) y nunca llegan al frontend.
- **[?]** ¿Una sola razón social o varias? (pregunta P1)

### 1.2 Sucursales
| Campo | Notas |
|---|---|
| Nombre | **[B]** La primera se crea por defecto como matriz. |
| Dirección y código postal | El CP de la sucursal es el **lugar de expedición** del CFDI. |
| IVA por defecto | **[B]** Tasa predeterminada para ventas de esa sucursal (16% / 8% / 0%). |
| CSD propio (opcional) | **[B]** Solo si factura con otra razón social. |
| Serie de folios | **[E]** Una serie por sucursal y por tipo de documento (1.4). |
| Configuración de impresión | **[E]** Logo, datos fiscales, leyendas y tamaño de papel (sección 12). |
| Activa / inactiva | No se borra si tiene movimientos **[B]**. |

### 1.3 Almacenes
| Campo | Notas |
|---|---|
| Nombre | |
| Sucursal | Obligatoria **[B]**. |
| Existencia pública | **[B]** En Bind otras sucursales ven, pero no usan, la existencia. En [NOMBRE] **todos** ven existencias de todas las sucursales **[E]**, así que este campo no hace falta. |
| Multisucursal | **[B]** Bind permite usar un almacén desde cualquier sucursal. **[?]** ¿Lo necesitas? (P2) |
| Ubicación | **[B]** Texto libre por producto y almacén (pasillo, nivel). |

- **Listado [B]**: número, nombre, sucursal y las dos marcas. Acciones: ver existencias, editar y eliminar (solo si no tiene existencias).

### 1.4 Series y folios
- **[B]** Una serie se define por tipo de documento + nombre + número inicial + sucursales que la usan. El número inicial debe ser mayor que el último folio emitido.
- **[E]** Consecutivo **por sucursal**, con **series nuevas** que no choquen con las de Bind.
- Tipos de documento con folio: cotización, venta (nota/remisión), apartado, abono/recibo, entrega, entrada de mercancía, traspaso, ajuste/conteo, corte de caja, factura, complemento de pago, nota de crédito y factura global.
- Ejemplo ficticio: sucursal Centro → `CEN-V` ventas, `CEN-C` cotizaciones, `CENF` facturas.

### 1.5 Cajas
- **[E]** Cada sucursal tiene una o más cajas. En Bind el POS se configura con almacén, serie y cliente por defecto **[B]**; [NOMBRE] lo amarra a la caja.
- Campos: nombre, sucursal, almacén de salida por defecto, serie de ventas, cliente por defecto (público en general), impresora o ancho de ticket.

### 1.6 Usuarios, roles y permisos
- **[B]** Usuario: nombre, correo, puesto, teléfono y contraseña. Los permisos son interruptores por módulo y sección, y se agrupan en "grupos de permisos" que se asignan al usuario. Bind también ofrece 2FA.
- **[E]** Roles base: administrador, gerente de sucursal, cajero/vendedor, almacenista y facturación. Un usuario puede tener varias sucursales.
- **[E]** Permisos finos configurables:

| Permiso | Ejemplo de uso |
|---|---|
| Ver costos | Oculta costo y utilidad en pantallas y reportes. |
| Aplicar descuentos | Hasta un % máximo **[?]** (P3). |
| Modificar precios | Cambiar el precio en la partida. |
| Cancelar ventas | Con motivo. |
| Ajustar inventario | Ajustes manuales y aplicar conteos. |
| Otorgar crédito | Vender a crédito y editar límite y días. |
| Cancelar apartados | |
| Timbrar facturas | |
| Cancelar facturas | |

- **[B]** Bind tiene además un permiso "ver existencias de almacenes sin acceso". En [NOMBRE] esa consulta es para todos **[E]**.
- **[E]** Se aplican con RLS en Postgres. Bitácora de acciones sensibles: quién, cuándo, valor anterior y valor nuevo.

### 1.7 Leyendas y plantillas de documentos
- **[B]** Una leyenda de texto libre por tipo de documento, impresa al pie del PDF o ticket.
- **[E]** Configurable por sucursal.

---

## 2. Productos

### 2.1 Listado de productos
- **[B]** Columnas: número, código, nombre, existencia (ordenable). Vista resumida: imagen, tipo, SKU/código de barras, unidad y descripción. Pestaña de inventario por almacén con existencia, mínimo y máximo.
- **[B]** Filtros: palabra clave, tipo y categoría.
- **[B]** Acciones: agregar, editar y eliminar (en bloque solo con existencia cero). Importar y exportar CSV, lotes y pedimentos, etiquetas y listas de precios.
- **[NOMBRE]** Mismas columnas más marca, categoría, activo y precio de la lista seleccionada. Filtros: marca, activo/inactivo y sucursal/almacén para la existencia. En lugar de eliminar, se **desactiva** si tiene movimientos.

### 2.2 Ficha de producto
| Sección | Campo | Origen | Notas |
|---|---|---|---|
| Detalle | Imagen | B/E | JPG o PNG. |
| | SKU (código interno) | B/E | Único. En Bind se llama "Código" y el "SKU" es el código de barras; en [NOMBRE] se usan los nombres de tu documento: **SKU** y **código de barras**. |
| | Código de barras | B/E | Opcional. Cada unidad de venta puede tener el suyo. |
| | Nombre | B/E | Hasta 255 caracteres. |
| | Descripción | B/E | |
| | Categoría | B/E | Jerárquica en Bind **[B]**. |
| | Marca | E | |
| | Tipo | B/E | Producto o servicio. Bind distingue producto terminado, materia prima y "concepto de venta"; [NOMBRE] usa producto/servicio **[E]**. Los servicios no llevan inventario. |
| | Activo / inactivo | E | |
| Costeo | Costo inicial | B | |
| | Método de costeo | B | Promedio o fijo. **[?]** ¿Usan fijo en algún producto? (P4) |
| | Costo promedio | B/E | Calculado, solo lectura. |
| | Moneda | B | **[?]** ¿Venden en USD? Tu documento dice MXN. (P5) |
| Fiscal | Clave SAT de producto/servicio | B/E | Catálogo del SAT. |
| | Clave SAT de unidad (unidad base) | B/E | Ej. MTK (m²), H87 (pieza). |
| | IVA | B/E | 16%, 8%, 0% o exento. |
| | IEPS | B/E | Opcional, con tasa. |
| | Objeto de impuesto | E | 01, 02, 03 (catálogo SAT). |
| Inventario | Unidad base | E | Ej. m². Todo el kardex se lleva en esta unidad. |
| | Permitir fracciones de la unidad base | E | Sí / no (solo cajas o piezas completas). |
| | Control por lote / pedimento | B/E | Opcional por producto. |
| Datos opcionales | Tiempo de surtido (días), peso y volumen | B | **[?]** ¿Los usan? (P6) |
| Por almacén | Mínimo, máximo, punto de reorden y ubicación | B/E | Bind tiene mínimo y máximo; el **punto de reorden** explícito lo pide tu documento. |
| Historial | Histórico de costos | B | Pestaña de solo lectura. |

- Variantes (color/talla), kits y producción automática **[B]** existen en Bind, pero quedan fuera. **[?]** (P6)

### 2.3 Unidades de venta (unidades alternas)
- **[B]** Por unidad: nombre, equivalencia (cuántas unidades base contiene), si es de venta, si es de compra y su clave SAT de unidad. Al elegirla en una venta, el precio se escala y el inventario se mueve en unidad base.
- **[E]** Además, en [NOMBRE] cada unidad tiene:
  - Factor a la unidad base, `numeric(14,4)`. Ej. caja = 1.4400 m², pieza = 0.3600 m², metro = 1.0000 m².
  - **Precio propio por lista de precios**, no solo escalado.
  - Código de barras opcional.
  - Clave SAT de unidad propia (ej. caja XBX).
- **Regla "solo completas" [E]**: si se pide en m² y el producto no permite fracciones, se sugieren cajas `= ceil(m² / factor)` y se muestran los m² reales. Ej. 10 m² con caja de 1.44 → **7 cajas = 10.08 m²**.
- **[?]** Si un producto se vende por pieza y por caja, ¿"solo completas" significa piezas enteras, o también permite piezas sueltas? (P7)

### 2.4 Listas de precios
- **[B]** Listas con nombre y una marcada como predeterminada. Cada producto necesita al menos un precio. Estrategia por listas o por volumen; tipo monto, margen o markup sobre el costo. Importación y actualización masiva de precios.
- **[E]** Precio por **producto × unidad de venta × lista**.
- **[?]** ¿Los precios incluyen IVA o no? En el POS de Bind se muestran con IVA. (P8)
- **[?]** ¿Usan precios por volumen o fórmulas de margen/markup? (P9)

### 2.5 Lotes y pedimentos
- **[B]** Se activan por producto. Lote: almacén, producto, cantidad y caducidad. Pedimento: tipo, número de 15 dígitos con estructura SAT (año, aduana, patente, dígito de año, consecutivo), fecha, aduana y estatus (abierto/cerrado). Se elige lote o pedimento al vender.
- **[?]** ¿Los usan hoy? Pisos y recubrimientos suelen manejar lote o tono. (P10)

### 2.6 Importación y exportación
- **[B]** Plantilla CSV para crear y otra para actualizar (identifica por ID). Se procesa, se muestra un resumen y luego se guarda. Descripción limitada a 250 caracteres; las categorías deben existir antes.
- **[E]** Excel o CSV con **vista previa fila por fila de errores** antes de confirmar. Incluye unidades de venta y precios por lista.

### 2.7 Etiquetas
- **[B]** Filtros: palabra clave, producto, tipo, lista de precios y categoría. Número de copias, tamaño, mostrar IVA sí/no y descripción sí/no. Salida en PDF.
- **[E]** Código de barras y precio. **[?]** Tamaños de etiqueta y tipo de impresora. (P11)

---

## 3. Clientes

### 3.1 Listado
- **[B]** Columnas: número, nombre y teléfono. Filtros: número, nombre, sucursal y vendedor. Panel lateral con total facturado, pendiente de cobro y pestañas de operaciones, actividades y archivos.
- **[NOMBRE]** Agrega RFC, saldo, saldo vencido y estado de bloqueo.

### 3.2 Ficha
| Grupo | Campo | Origen |
|---|---|---|
| Fiscal (CFDI 4.0) | RFC | B/E |
| | Nombre o razón social **exactamente** como en la constancia (en mayúsculas y sin régimen societario) | B/E |
| | Régimen fiscal | B/E |
| | Código postal fiscal | B/E |
| | Uso de CFDI por defecto | B/E |
| | Correo(s) para envío de facturas | B/E |
| Comercial | Nombre comercial | B |
| | Sucursal | B |
| | Vendedor asignado | B |
| | Lista de precios | B |
| | Descuento pactado (%) | B |
| | Origen ("¿cómo nos conoció?") | B **[?]** (P12) |
| Contacto | Teléfono(s), correo y comentarios | B |
| Direcciones | Calle, número exterior e interior, colonia, municipio, estado, país, CP y referencias. Varias direcciones (útil para entregas). | B |
| Crédito | Límite de crédito (MXN) | B/E |
| | Días de crédito | B/E |
| | Saldo (calculado) | E |
| | Bloqueo por saldo vencido (automático) más bloqueo manual | E |

- **[E]** "Público en general" (RFC XAXX010101000) viene por defecto en el POS. No se edita.
- **[?]** ¿Prospectos como catálogo aparte (como en Bind) o un cliente marcado como "prospecto"? (P13)

---

## 4. Inventarios

### 4.1 Existencias
- **[B]** Bind muestra existencias por almacén desde Almacenes y desde la ficha del producto. En la venta muestra "existencia" y "disponible" (disponible = existencia − reservado por pedidos).
- **[E]** Dos vistas:
  - **Por sucursal o almacén.** Columnas: SKU, producto, categoría, unidad base, existencia, apartado, pendiente por entregar, disponible, mínimo, máximo, punto de reorden y valor (si el usuario puede ver costos).
  - **Consolidada.** Una columna por sucursal más el total.
- **Unidad de despliegue [E]**: selector de unidad (ej. "3 cajas = 4.32 m²").
- **[?]** Fórmula de "disponible". Propuesta: `existencia − apartado`. Lo pendiente por entregar ya salió de la existencia (regla crítica). (P14)

### 4.2 Kardex (movimientos de producto)
- **[B]** Filtros: almacén (uno o todos), producto (obligatorio), rango de fechas, tipo de movimiento y orden. Columnas: fecha de creación, fecha de aplicación, almacén, lote, documento origen, valor, entradas, salidas, saldo corrido y enlace al documento.
- **[B]** Los ajustes no se borran; se corrigen con otro ajuste. Bind permite vender sin inventario por configuración y advierte que eso choca con el costo promedio.
- **[E]** Tipos de movimiento en [NOMBRE]: entrada de mercancía, venta, cancelación de venta, devolución, ajuste (+/−), traspaso de salida y traspaso de entrada. Además **inventario inicial** (para la migración).
- **[E]** El kardex es inmutable y la existencia nunca se edita directamente.

### 4.3 Entradas de mercancía (recepciones)
- **[B]** Encabezado: proveedor (se puede crear en el momento), almacén, moneda, número y fecha del documento del proveedor, días de crédito, tipo (factura/remisión) y comentarios. Se pueden crear desde el XML del proveedor. Partidas: producto, cantidad y costo. Con costo promedio, el sistema recalcula y pide confirmación. Se pueden agregar gastos (fletes) al costo.
- **[B]** Columnas del listado: número, proveedor, almacén, fecha de recepción, fecha del documento, número de documento, tipo, subtotal, impuestos, total, pendiente de pago y estatus.
- **[E]** Proveedor, costo y folio.
- **[?]** ¿Necesitan: (a) leer el XML del proveedor, (b) prorratear fletes al costo, (c) recibir en unidad de compra (ej. tarima)? (P15)
- **[?]** ¿Cuentas por pagar a proveedores? Bind las tiene; tu documento no las pide. (P16)

### 4.4 Traspasos
- **[B]** Almacén origen, almacén destino, fecha, partidas (producto, lote y cantidad, viendo existencias de ambos) y comentario. Al crearlo queda "en tránsito"; el destino registra la entrada. Solo se cancela si está en tránsito. Exportación CSV.
- **[E]** Estados: **enviado → en tránsito → recibido**.
- **[?]** ¿Qué diferencia hay entre "enviado" y "en tránsito"? Propuesta: enviado = capturado y salió del origen; en tránsito = va en camino (paso opcional, si se marca que ya salió el camión). (P17)
- **[?]** ¿Recepción parcial o con diferencias (llegó roto o incompleto)? Propuesta: el destino captura lo recibido y la diferencia queda como "faltante en tránsito" para que la autorice un gerente. (P18)

### 4.5 Ajustes y conteo físico
- **[B]** Ajuste manual: almacén, producto, cantidad (+/−), fecha y motivo obligatorio. Ajuste múltiple: almacén, referencia, fecha, motivo (catálogo), con columnas existencia / ajuste +/− / balance / ubicación. Carga por categoría. Historial filtrable por folio, almacén, producto, fechas, motivo y origen; se exporta a CSV.
- **[E]** Conteo físico:
  - Captura por caja, pieza o unidad base.
  - Vista previa de diferencias.
  - Ajuste autorizado.
  - **Considera lo vendido pendiente por entregar**: como ya se descontó de la existencia pero sigue físicamente en la bodega, `esperado en anaquel = existencia + pendiente por entregar`.
- **[?]** ¿El conteo congela movimientos del almacén mientras se hace, o se toma una "foto" de la existencia al iniciar y se compara? Propuesta: foto con hora de inicio, sumando los movimientos posteriores. (P19)

### 4.6 Puntos de reorden
- **[B]** Filtros: almacén, producto o categoría, nivel objetivo (mínimo, intermedio o máximo) y "solo bajo mínimo". Calcula la cantidad a comprar sumando lo comprometido en pedidos.
- **[E]** Se incluye como reporte (10.3).

### 4.7 Vinculación con hoja de cálculo de Google (requisito nuevo)
- **[E]** Hoy el inventario real se lleva en una hoja de Google porque en Bind nadie lo actualiza. El sistema nuevo debe poder **vincular el inventario con una hoja de cálculo**.
- **Regla que se mantiene:** la existencia nunca se edita directamente; todo cambio es un movimiento en el kardex. Por eso, la hoja no puede sobrescribir existencias.
- **Modos posibles** (P47):

| Modo | Qué hace | Recomendación |
|---|---|---|
| **A. Publicar a la hoja** | [NOMBRE] escribe automáticamente en la hoja las existencias por sucursal/almacén (y opcionalmente apartado, pendiente por entregar, mínimo y máximo). La hoja es una copia de solo lectura. | **Sí**, para quien ya trabaja con la hoja. |
| **B. Importar desde la hoja** | Se lee la hoja como **captura de un conteo** o como **carga inicial**. Se muestra la vista previa de diferencias y, al autorizar, se generan ajustes en el kardex. | **Sí**, para el corte y para conteos. |
| **C. Sincronización en ambos sentidos** | Lo que se edite en la hoja cambia la existencia del sistema. | **No recomendado:** rompe el kardex y la trazabilidad (no se sabe quién cambió qué ni por qué). |

- Configurable: ID de la hoja, pestaña, mapeo de columnas (SKU, almacén, cantidad, unidad), frecuencia y almacenes incluidos.
- Conexión mediante una cuenta de servicio de Google con acceso solo a esa hoja. Las credenciales van en variables de entorno o en Vault, nunca en el repositorio.

---

## 5. Cotizaciones

### 5.1 Listado
- **[B]** Columnas: número, fecha, cliente o prospecto, sucursal, total, moneda, estatus e indicador de comentarios. Filtros: número, cliente, capturista, sucursal, fechas, estatus y producto.
- **[B]** Estatus en Bind: activa, surtida y cancelada.
- **[E]** Estatus en [NOMBRE]: **borrador, enviada, vencida, convertida y cancelada**. "Vencida" se calcula por la vigencia.

### 5.2 Captura
- **[B]** Encabezado: cliente, prospecto o nuevo; almacén; moneda; lista de precios; fecha; vigencia; serie y folio; correo de notificación. Partidas: producto, cantidad, precio (editable), descuento por monto o %, comentario e IVA. Opciones: importar partidas de Excel y multiplicar cantidades.
- **[E]** Captura igual que el POS: producto, **unidad de venta**, cantidad, precio, descuento e impuestos. Calculadora de m² → cajas. Vendedor.
- **[?]** Vigencia por defecto en días. (P20)

### 5.3 Detalle y acciones
- **[B]** Muestra cliente, contacto, sucursal, lista, capturista, fechas, partidas (código, descripción, unidad, cantidad, precio, importe, IEPS, IVA) y totales. Acciones: generar pedido, generar venta, copiar, editar, exportar partidas, enviar por correo, PDF y marcar surtida.
- **[E]** Acciones en [NOMBRE]: imprimir o descargar PDF carta, reimprimir, duplicar, enviar por correo, cancelar y **convertir a venta con un clic**. Esta última:
  - Abre el POS con las mismas partidas, cliente y precios cotizados (si está vigente).
  - Avisa si hubo cambios de precio o falta de existencia.
  - Liga cotización y venta.
  - Una cotización no se convierte dos veces.
- **[?]** Si la cotización está vencida, ¿se puede convertir con los precios actuales o se bloquea? (P21)
- **[?]** Bind tiene un módulo de **Pedidos** (con reserva de existencia y anticipos) entre cotización y venta. Tu documento no lo menciona. ¿Se usa? Propuesta: no; los apartados cubren ese caso. (P22)

---

## 6. Punto de venta

### 6.1 Configuración y pantalla
- **[B]** Configuración: almacén, serie y cliente por defecto; interruptor "solo productos con existencia". Pantalla: cliente arriba con alta rápida, carrito, buscador por código o nombre, lector de código de barras, filtro por categoría, cuadrícula con foto, nombre, precio y existencia, y botón de total. **Varias ventas simultáneas en pestañas.** Indicador de conexión en línea o fuera de línea.
- **[E]** Uso ágil con teclado. Sin modo offline: si se cae la conexión, se muestra un **aviso claro** y **el carrito se conserva** en captura.
- **[?]** Atajos de teclado deseados. Propuesta: F2 buscar, F4 cliente, F8 cobrar, F9 apartado, Esc cancelar captura, +/− cantidad. (P23)

### 6.2 Partidas
- **[B]** Clic para agregar; un segundo clic suma cantidad. En la partida se cambia la unidad, el precio (lápiz) y la cantidad (teclado numérico), o se elimina. Los precios se muestran con IVA.
- **[E]** Selector de unidad de venta con su precio y la **equivalencia en unidad base**. Descuento y cambio de precio solo con permiso. Partida marcada "vendida sin existencia" si queda negativa.

### 6.3 Cobro
- **[B]** Pantalla de verificación con descuento, IVA e IEPS. Cuenta de cobro (caja o banco), forma de pago, botones rápidos de billetes y monedas, y pagos mixtos con "+ pago".
- **[E]** Efectivo, tarjeta y transferencia; pagos mixtos; cálculo de cambio.
- **[?]** ¿Tarjeta separada en débito y crédito (son claves SAT 28 y 04)? ¿Se captura referencia o autorización de la terminal? ¿Comisión bancaria? (P24)
- **[?]** ¿Vales, cheques u otras formas de pago? (P25)

### 6.4 Venta a crédito
- **[B]** Días de crédito del cliente, editables, que definen el vencimiento.
- **[E]** Cliente obligatorio; valida límite y saldo; bloqueo por saldo vencido.
- **[?]** ¿Un gerente con permiso puede autorizar una venta que excede el límite? (P26)

### 6.5 Apartados
- **Bind:** no encontré un apartado como tal en la ayuda. Lo más parecido son **Pedidos con anticipo**. **[CHROME]**
- **[E]** Anticipo, abonos, fecha límite y liquidación. Al cancelar, la devolución del anticipo sigue una regla configurable.
- **[E — supuesto a confirmar]** No descuentan inventario mientras están abiertos. Se muestran como "apartado" y descuentan al liquidarse y convertirse en venta.
- **[?]** Preguntas pendientes (P27):
  - Anticipo mínimo (%).
  - Plazo máximo.
  - Opciones de la regla de devolución: devolver todo, retener un %, o dejarlo como saldo a favor.
  - Qué pasa al vencer: se cancela solo o requiere acción.
  - ¿El precio se congela al apartar?

### 6.6 Entregas parciales
- **Bind:** solo encontré la "hoja de salida de almacén" de cada venta. No vi entregas parciales. **[CHROME]**
- **[E]** Cada partida guarda cantidad vendida y cantidad entregada. Cada entrega genera su comprobante. Hay vista de pendientes por entregar y nunca se entrega más de lo vendido.
- **[?]** ¿La entrega puede salir de otro almacén o sucursal distinto al de la venta? (P28)

### 6.7 Caja
- **[B]** Cierre de caja con usuario, sucursal, fecha y ventas acumuladas. Se captura el efectivo contado. El ticket de cierre se desglosa por montos, por artículos, por ambos o por ninguno. Los cajeros solo ven su propio cierre.
- **[E]** Apertura con fondo; entradas y salidas de efectivo con motivo; corte con **esperado vs contado por forma de pago** y diferencia.
- **[?]** ¿Corte por turno o por cajero (varios cajeros en una caja)? ¿Hay corte parcial o retiro de efectivo a media jornada? (P29)

### 6.8 Cancelaciones y devoluciones
- **[B]** Para cancelar hay que quitar antes los pagos aplicados; requiere permiso y pide motivo. Las facturas se cancelan también ante el SAT. Las devoluciones se registran como nota de crédito "por devolución".
- **[E]** Una venta confirmada no se edita: se cancela y la existencia regresa con un movimiento inverso. Si estaba facturada, se cancela el CFDI o se emite nota de crédito.
- **[?]** Devolución parcial en efectivo vs saldo a favor; ¿plazo máximo para devolver? (P30)

### 6.9 Ventas: "remisión" vs "factura"
- **[B]** En Bind, al capturar la venta se elige remisión (nota sin validez fiscal), factura (se timbra al guardar) o prefactura (borrador editable). Las remisiones se facturan después, una o varias juntas.
- **[NOMBRE] (propuesta)**: toda venta del POS es una **nota de venta**. La factura se genera desde la venta (al momento o después), una o varias del mismo cliente. Así hay un solo flujo de inventario y caja. **[?]** (P31)

---

## 7. Crédito y cobranza

### 7.1 Cuentas por cobrar
- **[B]** Pestañas: vencidas, al corriente, histórico y "próximas a vencer" (margen de días).
- **[B]** Filtros: número, cliente, vendedor, palabra clave, almacén, sucursal, tipo de documento, estatus, estatus CFDI, emisión, vencimiento, método de pago PUE/PPD y moneda.
- **[B]** Columnas: número, tipo, fecha, cliente, sucursal, almacén, vencimiento, UUID, subtotal, impuestos, total, pendiente, estatus y estado SAT. Exportación a Excel.
- **[E]** Se replica completo.

### 7.2 Abonos
- **[B]** Abono: cuenta (caja o banco), forma de pago, monto (total o parcial), referencia y fecha. Si la factura es PPD, se genera el complemento de pago automáticamente. Un pago puede cubrir varias facturas.
- **[E]** Recibo de abono impreso. La suma de abonos cuadra con el saldo y nunca lo deja negativo. Se puede abonar a facturas PPD **emitidas en Bind** usando su UUID (migración).
- **[?]** Si un cliente paga de más, ¿queda saldo a favor (anticipo)? (P32)

### 7.3 Estado de cuenta
- **[B]** Listado por cliente: días de crédito, límite, saldo, saldo vencido y % vencido. Detalle con pestañas de facturas y pagos. Envío del PDF por correo y portal del cliente.
- **[E]** PDF del estado de cuenta.
- **[?]** Rangos de antigüedad de saldos. Propuesta: 0–30, 31–60, 61–90 y más de 90 días. (P33)

---

## 8. Facturación (CFDI 4.0)

### 8.1 Facturar ventas
- **[B]** Se seleccionan ventas o remisiones no facturadas de un cliente (o de varios, para la global). Filtros: serie, fechas, sucursal, estatus y moneda. Opción de agrupar todo en un solo concepto. No se facturan las que tienen nota de crédito aplicada.
- **[E]** Una o varias ventas del mismo cliente. PUE si está pagada, PPD si es a crédito o en parcialidades. Se validan los datos del receptor antes de timbrar y los errores del PAC se muestran en lenguaje claro.

### 8.2 Factura global
- **[B]** Cliente público en general, periodicidad, mes y año, método PUE y la forma de pago del comprobante de mayor monto. Se seleccionan las notas no facturadas y se pueden agrupar.
- **[E]** Igual. Una venta ya facturada no entra.
- **[?]** Periodicidad que usan: diaria, semanal, quincenal o mensual. ¿Una global por sucursal? (P34)

### 8.3 Complemento de pago 2.0
- **[B]** Se genera al registrar el abono. Un pago puede cubrir varias facturas. Se cancela con motivo.
- **[E]** Saldo anterior, importe pagado y saldo insoluto.

### 8.4 Notas de crédito (egreso)
- **[B]** Dos tipos: **por monto** (concepto + importe) y **por devolución** (productos facturados, cantidad original y devuelta). Relación con la factura origen; el CFDI es opcional.
- **[E]** Por devoluciones y descuentos, relacionadas con la factura origen. Una devolución regresa existencia con un movimiento de "devolución".

### 8.5 Anticipos
- **[B]** El anticipo se factura como ingreso PUE. Al facturar la venta, se aplica con relación 07; si se devuelve, se emite un egreso.
- **[E]** Para apartados, seguir la Guía de llenado del SAT (se verificará contra la guía vigente en la fase 9).

### 8.6 Cancelación
- **[B]** Motivos con sustitución (01, que requiere el CFDI sustituto con fecha igual o posterior). Estados SAT: activa, cancelada, pendiente de cancelación, cancelación rechazada, no cancelable y error al cancelar.
- **[E]** Motivos 01–04 y seguimiento de estatus.

### 8.7 Representación impresa y envío
- **[B]** PDF y XML; envío por correo al guardar si el cliente tiene correo. Descarga masiva mensual en ZIP.
- **[E]** PDF con el diseño de [NOMBRE].

### 8.8 Fuera de alcance por ahora
- Autofacturación (fase opcional) **[E]**.
- Addendas, retenciones de IVA/ISR, carta porte, comercio exterior y moneda extranjera. **[?]** ¿Retenciones? (P35)

---

## 9. Proveedores (mínimo para entradas)
- **[B]** Bind tiene catálogo de proveedores con alta, edición, importación y exportación, notas de crédito de proveedor y la lista EFOS.
- **[E]** Solo se necesita para entradas de mercancía: nombre, RFC, contacto y días de crédito. **[?]** (P16)

---

## 10. Reportes

Todos los reportes tienen filtros, vista en pantalla, impresión y exportación a Excel o CSV **[E]**.

### 10.1 Ventas
| Reporte | Filtros (Bind **[B]** + tu documento **[E]**) | Columnas / agrupación |
|---|---|---|
| **Histórico de ventas** | Cliente, vendedor, sucursal, almacén, producto, categoría, tipo de documento, fechas, lista de precios, tasa de impuesto, estatus, lote, usuario que capturó y canal **[B]** | Número, fecha, cliente, costo, utilidad, subtotal, descuento, IVA, IEPS, total, pagos, notas de crédito, saldo y estatus **[B]**. Agrupable por almacén, categoría, cliente, estatus, lista, mes, producto, serie, sucursal, tipo de documento y vendedor **[B]**. Total del periodo arriba. |
| **Tendencias de ventas y ganancia** | Sucursal, fecha inicial, número de periodos (±), intervalo (día, semana, mes o año) y agrupar por cliente, vendedor o producto **[B]** | Gráfica de barras; métrica: monto, número de ventas o piezas **[B]**. Se agrega ganancia **[E]**. |
| **Ventas por producto / vendedor / sucursal** | Generales | Derivado del histórico con agrupación **[E]**. |
| **Comisiones** | Fechas, base (ventas o cobranza), fórmula (monto o %), valor e incluir IVA **[B]** | Detalle por vendedor o cobrador, desplegable, y gráfica de participación **[B]**. **[?]** Reglas de comisión reales. (P36) |
| **Cotizaciones por estado y conversión** | Fechas, sucursal y vendedor **[E]** | Conteo y monto por estado; tasa = convertidas / (emitidas − canceladas) **[?]** (P37). |

### 10.2 Cobranza y crédito
| Reporte | Filtros | Columnas / agrupación |
|---|---|---|
| **Cobranza por método de pago** | Cliente, vendedor, sucursal, almacén, cuenta, tipo de documento, fechas, factura, referencia, moneda, tasa de IVA y forma de pago **[B]** | Operación, fecha, cliente, factura, cuenta, forma de pago, referencia, costo, margen, subtotal, IVA, total e ingreso **[B]**. Agrupable por forma de pago, sucursal, cliente, mes, vendedor, etc. **[B]** |
| **Cuentas por cobrar / antigüedad de saldos** | Cliente, sucursal, vendedor y fecha de corte | Rangos de antigüedad (P33). |
| **Estado de cuenta por cliente** | Cliente y fechas | Movimientos cargo/abono y saldo. |
| **Apartados vigentes y vencidos** | Sucursal, fechas y estado **[E]** | Folio, cliente, total, anticipo, abonado, saldo y fecha límite. |
| **Pendientes por entregar** | Sucursal, almacén, cliente y producto **[E]** | Venta, fecha, producto, vendido, entregado y pendiente (en unidad vendida y base). |

### 10.3 Inventario
| Reporte | Filtros | Columnas |
|---|---|---|
| **Existencias actuales** (por sucursal y consolidado) | Sucursal, almacén, categoría, marca y producto | Ver 4.1. |
| **Valor del inventario** | Ídem, a fecha | Existencia × costo promedio. Requiere permiso de ver costos. |
| **Movimientos de producto (kardex)** | Ver 4.2 **[B]** | Ver 4.2 **[B]** |
| **Inventarios históricos (existencia a una fecha)** | Almacén, producto, categoría y rango de fechas **[B]** | Código, nombre, inicial, final, diferencia, compras, ventas, devoluciones, ajustes, traspasos y costo promedio **[B]** |
| **Puntos de reorden** | Ver 4.6 **[B]** | Producto, almacén, existencia, mínimo, máximo, punto de reorden y sugerido a comprar. |
| **Existencia negativa** | Sucursal, almacén y categoría **[E]** | Producto, almacén y existencia. |
| **Ventas sin existencia** | Fechas, sucursal y producto **[E]** | Venta, partida, cantidad faltante y costo usado. |

### 10.4 Compras y caja
| Reporte | Filtros | Agrupación |
|---|---|---|
| **Compras / recepciones** | Proveedor, tipo, número, almacén, producto, categoría, IVA, estatus de pago, fechas y lote **[B]** | Proveedor, almacén, producto, categoría, mes y estatus; gráficas **[B]**. |
| **Cortes de caja** | Sucursal, caja, cajero y fechas **[E]** | Fondo, ventas por forma de pago, entradas, salidas, esperado, contado y diferencia. |

### 10.5 Facturación
| Reporte | Contenido |
|---|---|
| **Facturas emitidas / canceladas** | Serie, folio, UUID, cliente, fecha, total, método, estado SAT **[E]**. |
| **Pendientes de complemento de pago** | Facturas PPD con saldo y abonos sin complemento **[E]**. |
| **Ventas pendientes de factura global** | Notas a público en general no facturadas, por sucursal y periodo **[E]**. |

---

## 11. Documentos impresos

| Documento | Formato | Contenido mínimo (propuesta; sin ejemplos en `/referencia`) |
|---|---|---|
| Ticket de venta | Térmico 58 y 80 mm | Logo, datos fiscales de la sucursal, folio, fecha y hora, cajero, cliente, partidas **en la unidad vendida** (ej. "7 CAJA · 10.08 m²"), precio, importe, descuento, subtotal, IVA, total, formas de pago, cambio, leyenda. Reimpresión marcada **"COPIA"**. |
| Cotización | Carta, PDF | Encabezado, cliente, vendedor, vigencia, partidas con unidad, totales, leyenda y condiciones. |
| Nota de venta / remisión | Carta, PDF | Como el ticket, en carta. |
| Factura y complemento de pago | Carta, PDF | Representación impresa del CFDI: UUID, sellos, QR, cadena original y datos del SAT. |
| Recibo de abono | Ticket y carta | Cliente, documento(s) abonado(s), saldo anterior, abono y saldo nuevo. |
| Comprobante de apartado | Ticket y carta | Anticipo, abonos, saldo, fecha límite y regla de cancelación. |
| Nota de entrega parcial | Carta | Venta origen, partidas entregadas en esta entrega, acumulado entregado y pendiente; espacio para firma. **[B]** Equivalente a la "hoja de salida de almacén". |
| Corte de caja | Ticket | Ver 10.4. **[B]** Opción de desglose por montos o artículos. |
| Traspaso | Carta | Origen, destino, partidas y firmas de envío y recepción. |
| Entrada de mercancía | Carta | Proveedor, documento, partidas y costos (si hay permiso). |
| Etiquetas | Ver 2.7 | Código de barras, nombre y precio. |

- **[B]** Bind imprime tickets mediante un componente instalado en la PC (sin diálogo del navegador). La propuesta para [NOMBRE] (agente local ESC/POS o modo kiosko) se presenta en la fase de plan **[E]**.
- **[CHROME]** Revisar el ticket y los PDF reales de Bind para igualar el contenido. Sin `/referencia`, la tabla anterior es una propuesta.

---

## 12. Configuración de impresión por sucursal
- Logo, datos fiscales que se muestran, leyendas por tipo de documento, ancho de ticket (58 u 80 mm) y número de copias **[E]/[B]**.

---

## 13. Diferencias clave entre Bind y [NOMBRE]

| Tema | Bind (ayuda pública) | [NOMBRE] |
|---|---|---|
| Unidades de venta | Precio escalado por equivalencia | Precio **propio** por unidad y lista. |
| Regla de cajas completas | No documentada | Redondeo hacia arriba con m² reales. |
| Cotización | Activa, surtida o cancelada; pasa a pedido o a venta | 5 estados; conversión con un clic e idempotente. |
| Pedidos | Módulo con reserva y anticipos | No incluido (P22); en su lugar, apartados. |
| Apartados | No documentados | Incluidos. |
| Entregas parciales | No documentadas | Incluidas, con pendiente por entregar. |
| Venta sin existencia | Configuración global; advierte de problemas con el costo | Siempre permitida, con aviso, marca y regla de costo explícita. |
| Corte de caja | Captura efectivo contado | Esperado vs contado por forma de pago, entradas y salidas. |
| Permisos | Interruptores por módulo en la interfaz | Roles + permisos finos **en RLS**, y bitácora. |
| Offline | Indicador en línea / fuera de línea | Sin offline; aviso y carrito conservado. |

---

## 14. Preguntas abiertas

**Empresa y estructura**
- **P1.** ¿Facturan con una sola razón social o con varias (por sucursal)? *En Chrome se ve una sola (persona física). No pude ver si alguna sucursal tiene CSD propio. ¿Confirmas?*
- **P2.** ¿Algún almacén se comparte entre sucursales (multisucursal)? *En Chrome se ve que sí: "General" es multisucursal. ¿Sigue siendo necesario?*
- **P3.** ¿El permiso de descuento lleva un % máximo por rol o por usuario?

**Productos**
- **P4.** ¿Algún producto usa costo fijo en lugar de costo promedio?
- **P5.** ¿Venden o compran en dólares?
- **P6.** ¿Usan variantes, kits/paquetes, peso/volumen o tiempo de surtido?
- **P7.** Con "solo completas", ¿se pueden vender piezas sueltas además de cajas?
- **P8.** ¿Los precios de lista incluyen IVA?
- **P9.** ¿Usan precios por volumen o fórmulas de margen o markup?
- **P10.** ¿Controlan lote, tono/calibre o pedimento? ¿En qué productos?
- **P11.** Tamaño de etiquetas e impresora de etiquetas.

**Clientes**
- **P12.** ¿Usan "origen del cliente" o canal de venta?
- **P13.** ¿Prospectos como catálogo aparte o como cliente marcado?

**Inventario**
- **P14.** ¿Confirmas la fórmula disponible = existencia − apartado?
- **P15.** En entradas: ¿leer XML del proveedor, prorratear fletes, recibir en unidad de compra?
- **P16.** ¿Necesitan cuentas por pagar y órdenes de compra, o solo entradas?
- **P17.** ¿Qué distingue "enviado" de "en tránsito" en un traspaso?
- **P18.** ¿Traspasos con recepción parcial o con diferencias?
- **P19.** ¿El conteo físico congela el almacén o compara contra una foto?

**Cotizaciones**
- **P20.** ¿Vigencia por defecto de las cotizaciones (días)?
- **P21.** ¿Una cotización vencida se puede convertir a venta con precios actuales?
- **P22.** ¿Usan Pedidos de Bind? ¿Los dejamos fuera? *En Chrome se ven prácticamente sin uso; propongo dejarlos fuera.*

**Punto de venta y caja**
- **P23.** ¿Atajos de teclado preferidos?
- **P24.** ¿Tarjeta de débito y de crédito por separado? ¿Referencia de terminal? ¿Comisión?
- **P25.** ¿Otras formas de pago (vales, cheque)?
- **P26.** ¿Autorización de un gerente para exceder el límite de crédito?
- **P27.** Apartados: anticipo mínimo, plazo, regla de devolución al cancelar, qué pasa al vencer, ¿se congela el precio?
- **P28.** ¿Una entrega puede salir de otro almacén distinto al de la venta?
- **P29.** ¿Corte por turno o por cajero? ¿Retiros parciales?
- **P30.** Devoluciones: ¿reembolso o saldo a favor? ¿Plazo máximo?
- **P31.** ¿Confirmas que toda venta es una nota de venta y que la factura se genera desde ella?

**Crédito y cobranza**
- **P32.** ¿El pago en exceso queda como saldo a favor?
- **P33.** ¿Rangos de antigüedad de saldos?

**Facturación**
- **P34.** ¿Periodicidad de la factura global? ¿Una por sucursal?
- **P35.** ¿Necesitan retenciones (IVA o ISR) o addendas para algún cliente?

**Reportes**
- **P36.** ¿Cómo calculan hoy las comisiones (sobre venta o sobre cobranza, %, por producto)?
- **P37.** ¿Confirmas la fórmula de tasa de conversión de cotizaciones?

**Fuera de alcance**
- **P38.** ¿Algo de contabilidad, gastos, producción o marketplaces de Bind se usa hoy y debe migrarse?

**Surgidas de la revisión en Chrome (sección 0.1)**
- **P39.** ¿Aceptas guardar las equivalencias con 8 decimales y las cantidades con 6 (en lugar de 4), para que piezas como 0.023816 m² no generen diferencias de redondeo?
- **P40.** ~~¿Migrar existencias negativas?~~ **Respondida:** las existencias de Bind no son confiables (nadie las actualiza; el control real está en una hoja de cálculo de Google). La existencia inicial saldrá del **conteo físico del corte** o de la hoja de Google, no de Bind.
- **P41.** ¿Quién corrige las claves SAT de producto (hoy genéricas) y cuándo: antes de migrar o en [NOMBRE]?
- **P42.** ¿Cobrar en el mismo paso de la venta (POS) y dejar "pendiente de pago" solo las ventas a crédito? ¿O necesitan conservar "vender ahora, cobrar después" para contado?
- **P43.** Las remisiones salen con IVA 0%. ¿El precio de lista ya incluye IVA y se desglosa solo al facturar? ¿O es otra razón?
- **P44.** ¿Crearemos un usuario por persona (cajero/vendedor) en lugar de uno por tienda? Lo recomiendo para la bitácora y las comisiones.
- **P45.** ¿Cuántas facturas emiten al mes, aproximadamente? ¿Las hacen desde remisiones o directas? Hay series de facturas, pero lo visible son remisiones.
- **P47.** Hoja de Google: ¿qué dirección necesitas? (ver 4.7)
- **P48.** Hoja de Google: ¿cuáles son sus columnas y pestañas (solo los encabezados, sin datos)? ¿Una hoja por sucursal o una sola?
- **P49.** Hoja de Google: ¿quién la usa hoy y para qué (consultar existencias, pedidos al proveedor, conteos)? ¿Seguirá usándose después de la salida de Bind?
- **P50.** Hoja de Google: ¿con qué frecuencia debe actualizarse (al momento, cada X minutos, una vez al día)?
- **P46.** Configuración, POS, transferencias y ajuste múltiple no se abren con tu usuario. ¿Hay otro usuario administrador con el que debo revisarlas, o las diseño según la ayuda pública?

---

## 15. Siguiente paso
1. Responde las preguntas (pueden ir por bloques).
2. Las marcas **[CHROME]** que quedan corresponden a pantallas sin acceso con tu usuario (P46). También sirven tickets, cotizaciones, hojas de salida o reportes impresos escaneados con datos tapados.
3. Con tu confirmación paso a la **Fase 2: plan, modelo de datos, supuestos y preguntas**.
