/**
 * Pruebas obligatorias del núcleo (fases 3–6) contra Postgres real.
 * Cada prueba corresponde a un punto de "Pruebas obligatorias" de la especificación.
 */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, asUser, q, key, stock, Seed } from "./setup";

let s: Seed;

beforeAll(async () => {
  await startDb();
  s = await seed();
  // Existencia inicial (ficticia) mediante ajuste de inventario inicial
  for (const [alm, cant] of [[s.almA, 100], [s.almB, 50], [s.almA2, 20]] as const) {
    await rpc(s.admin, "registrar_ajuste", {
      almacen_id: alm, motivo: "Inventario inicial de prueba", origen: "inventario_inicial", idempotency_key: key(),
      partidas: [
        { producto_id: s.piso.id, unidad_venta_id: s.piso.m2, cantidad: cant },
        { producto_id: s.pisoCajas.id, unidad_venta_id: s.pisoCajas.m2, cantidad: cant },
      ],
    });
  }
}, 180_000);

afterAll(async () => { await stopDb(); });

const venta = (over: Record<string, unknown> = {}, partidas?: unknown[], pagos?: unknown[]) => ({
  idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "contado",
  partidas: partidas ?? [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360 }],
  pagos: pagos ?? [{ forma: "efectivo", importe: 1000 }],
  ...over,
});

describe("Inventario y ventas", () => {
  it("dos ventas simultáneas del mismo producto se confirman y descuentan ambas sin perder movimientos", async () => {
    const antes = await stock(s.piso.id, s.almA);
    const cantidad = 40; // cajas: 57.6 m² cada una -> deja la existencia negativa
    const partidas = [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad, precio_unitario: 360 }];
    const pagos = [{ forma: "efectivo", importe: 20000 }];
    const [a, b] = await Promise.all([
      rpc(s.cajeroA, "confirmar_venta", venta({}, partidas, pagos)),
      rpc(s.cajeroA, "confirmar_venta", venta({}, partidas, pagos)),
    ]);
    expect(a.venta_id).not.toBe(b.venta_id);
    expect(a.folio).not.toBe(b.folio);
    const despues = await stock(s.piso.id, s.almA);
    expect(despues).toBeCloseTo(antes - 2 * 40 * 1.44, 6);
    expect(despues).toBeLessThan(0);
    const movs = await q(`select count(*)::int n from movimientos where documento_id = any($1)`, [[a.venta_id, b.venta_id]]);
    expect(movs[0].n).toBe(2);
    // Al menos una quedó marcada como vendida sin existencia, con aviso
    const avisos = [...a.avisos, ...b.avisos];
    expect(avisos.length).toBeGreaterThan(0);
  });

  it("una cancelación devuelve exactamente lo descontado", async () => {
    const antes = await stock(s.piso.id, s.almA);
    const v = await rpc(s.cajeroA, "confirmar_venta", venta({}, [
      { producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 3, precio_unitario: 360 },
      { producto_id: s.piso.id, unidad_venta_id: s.piso.pieza, cantidad: 7, precio_unitario: 90 },
    ], [{ forma: "efectivo", importe: 2000 }]));
    expect(await stock(s.piso.id, s.almA)).toBeCloseTo(antes - (4.32 + 2.52), 6);
    // El cajero no tiene permiso de cancelar; el administrador sí
    await expect(asUser(s.cajeroA, (c) => c.query(`select cancelar_venta($1, 'Error de captura')`, [v.venta_id])))
      .rejects.toThrow(/permiso/);
    await asUser(s.admin, (c) => c.query(`select cancelar_venta($1, 'Error de captura')`, [v.venta_id]));
    expect(await stock(s.piso.id, s.almA)).toBeCloseTo(antes, 6);
    const sum = await q(`select sum(cantidad)::numeric s from movimientos where documento_id = $1`, [v.venta_id]);
    expect(Number(sum[0].s)).toBe(0);
  });

  it("vender 3 cajas, 2.5 m² y 4 piezas descuenta 8.26 m² exactos", async () => {
    const antes = await q(`select cantidad from existencias where producto_id=$1 and almacen_id=$2`, [s.piso.id, s.almA]);
    await rpc(s.cajeroA, "confirmar_venta", venta({}, [
      { producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 3, precio_unitario: 360 },
      { producto_id: s.piso.id, unidad_venta_id: s.piso.m2, cantidad: 2.5, precio_unitario: 250 },
      { producto_id: s.piso.id, unidad_venta_id: s.piso.pieza, cantidad: 4, precio_unitario: 90 },
    ], [{ forma: "efectivo", importe: 2500 }]));
    const despues = await q(`select cantidad, (select $3::numeric - cantidad) diff from existencias where producto_id=$1 and almacen_id=$2`,
      [s.piso.id, s.almA, antes[0].cantidad]);
    expect(despues[0].diff).toBe("8.260000"); // numeric exacto, sin flotantes
  });

  it("con solo cajas completas, 10 m² con caja de 1.44 m² son 7 cajas (10.08 m²) y no acepta fracciones", async () => {
    const r = await q(`select * from calcular_unidades($1, 10)`, [s.pisoCajas.caja]);
    expect(Number(r[0].unidades)).toBe(7);
    expect(r[0].cantidad_base_real).toBe("10.080000");
    await expect(rpc(s.cajeroA, "confirmar_venta", venta({}, [
      { producto_id: s.pisoCajas.id, unidad_venta_id: s.pisoCajas.caja, cantidad: 6.5, precio_unitario: 432 },
    ], [{ forma: "efectivo", importe: 5000 }]))).rejects.toThrow(/unidades completas/);
  });

  it("la existencia coincide siempre con la suma del kardex", async () => {
    const dif = await q(`
      select e.producto_id, e.almacen_id, e.cantidad, coalesce(sum(m.cantidad),0) kardex
        from existencias e left join movimientos m on m.producto_id = e.producto_id and m.almacen_id = e.almacen_id
       group by e.producto_id, e.almacen_id, e.cantidad
      having e.cantidad <> coalesce(sum(m.cantidad),0)`);
    expect(dif).toEqual([]);
    // y el saldo corrido del último movimiento es la existencia
    const saldo = await q(`
      select e.cantidad, (select saldo from movimientos m where m.producto_id=e.producto_id and m.almacen_id=e.almacen_id
                           order by id desc limit 1) saldo
        from existencias e where exists (select 1 from movimientos m where m.producto_id=e.producto_id and m.almacen_id=e.almacen_id)`);
    for (const r of saldo) expect(r.saldo).toBe(r.cantidad);
  });

  it("la suma de todas las sucursales coincide con el inventario general", async () => {
    const r = await q(`
      with por_sucursal as (
        select e.producto_id, a.sucursal_id, sum(e.cantidad) c from existencias e join almacenes a on a.id = e.almacen_id
         group by e.producto_id, a.sucursal_id)
      select p.producto_id, sum(p.c) suc, (select sum(cantidad) from existencias where producto_id = p.producto_id) total
        from por_sucursal p group by p.producto_id`);
    expect(r.length).toBeGreaterThan(0);
    for (const x of r) expect(x.suc).toBe(x.total);
  });

  it("el kardex es inmutable", async () => {
    await expect(q(`update movimientos set cantidad = 1 where id = (select min(id) from movimientos)`)).rejects.toThrow(/inmutable/);
    await expect(q(`delete from movimientos where id = (select min(id) from movimientos)`)).rejects.toThrow(/inmutable/);
  });

  it("un doble clic (misma clave) no duplica la venta, ni en paralelo", async () => {
    const p = venta();
    const [a, b] = await Promise.all([rpc(s.cajeroA, "confirmar_venta", p), rpc(s.cajeroA, "confirmar_venta", p)]);
    expect(a.venta_id).toBe(b.venta_id);
    expect([a.repetida, b.repetida].sort()).toEqual([false, true]);
    const n = await q(`select count(*)::int n from ventas where idempotency_key = $1`, [p.idempotency_key]);
    expect(n[0].n).toBe(1);
  });

  it("si algo falla, no se guarda nada (atomicidad)", async () => {
    const antes = await stock(s.piso.id, s.almA);
    const ventasAntes = (await q(`select count(*)::int n from ventas`))[0].n;
    // pago insuficiente -> error al final, después de mover inventario
    await expect(rpc(s.cajeroA, "confirmar_venta", venta({}, undefined, [{ forma: "efectivo", importe: 1 }])))
      .rejects.toThrow(/no cubre/);
    expect(await stock(s.piso.id, s.almA)).toBe(antes);
    expect((await q(`select count(*)::int n from ventas`))[0].n).toBe(ventasAntes);
  });

  it("vender sin existencia deja costo pendiente que se corrige al llegar la entrada", async () => {
    const neg = await stock(s.piso.id, s.almA);
    expect(neg).toBeLessThan(0);
    const pend = await q(`select coalesce(sum(cantidad_pendiente),0)::numeric p from costo_pendiente where producto_id=$1 and almacen_id=$2`, [s.piso.id, s.almA]);
    expect(Number(pend[0].p)).toBeGreaterThan(0);
    await rpc(s.almacenista, "registrar_entrada", {
      almacen_id: s.almA, documento_proveedor: "FAC-PRUEBA-1", idempotency_key: key(),
      partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 200, costo_unitario: 230.4 }], // 160/m²
    });
    const ajustes = await q(`select sum(cantidad)::numeric c, min(costo_real)::numeric cr from ajustes_costo_venta`);
    expect(Number(ajustes[0].c)).toBeCloseTo(Number(pend[0].p), 6);
    expect(Number(ajustes[0].cr)).toBe(160);
    const prod = await q(`select costo_promedio from productos where id=$1`, [s.piso.id]);
    expect(Number(prod[0].costo_promedio)).toBe(160); // existencia previa negativa no pondera
  });
});

describe("Cotizaciones", () => {
  it("convertir una cotización crea una sola venta idéntica; un segundo clic no crea otra", async () => {
    const cot = await rpc(s.cajeroA, "guardar_cotizacion", {
      sucursal_id: s.sucA, almacen_id: s.almA, cliente_id: s.cliente, idempotency_key: key(),
      partidas: [
        { producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 5, precio_unitario: 360 },
        { producto_id: s.servicio.id, unidad_venta_id: s.servicio.unidad, cantidad: 1, precio_unitario: 500 },
      ],
    });
    const prep = await asUser(s.cajeroA, async (c) => (await c.query(`select preparar_conversion($1) r`, [cot.cotizacion_id])).rows[0].r);
    expect(prep.vigente).toBe(true);
    expect(prep.partidas).toHaveLength(2);

    const partidas = prep.partidas.map((x: any) => ({
      producto_id: x.producto_id, unidad_venta_id: x.unidad_venta_id, cantidad: x.cantidad, precio_unitario: x.precio_cotizado,
    }));
    const total = (await q(`select total from cotizaciones where id=$1`, [cot.cotizacion_id]))[0].total;
    const v1 = await rpc(s.cajeroA, "confirmar_venta", venta({ cliente_id: s.cliente, cotizacion_id: cot.cotizacion_id },
      partidas, [{ forma: "tarjeta_debito", importe: Number(total) }]));
    const v = (await q(`select total, cotizacion_id from ventas where id=$1`, [v1.venta_id]))[0];
    expect(v.total).toBe(total);
    expect(v.cotizacion_id).toBe(cot.cotizacion_id);
    expect((await q(`select estado, venta_id from cotizaciones where id=$1`, [cot.cotizacion_id]))[0])
      .toEqual({ estado: "convertida", venta_id: v1.venta_id });

    await expect(rpc(s.cajeroA, "confirmar_venta", venta({ cliente_id: s.cliente, cotizacion_id: cot.cotizacion_id },
      partidas, [{ forma: "tarjeta_debito", importe: Number(total) }]))).rejects.toThrow(/convertida/);
    expect((await q(`select count(*)::int n from ventas where cotizacion_id=$1`, [cot.cotizacion_id]))[0].n).toBe(1);
  });

  it("las cotizaciones no mueven inventario", async () => {
    const antes = (await q(`select count(*)::int n from movimientos`))[0].n;
    await rpc(s.cajeroA, "guardar_cotizacion", {
      sucursal_id: s.sucA, almacen_id: s.almA, prospecto: "Prospecto Ficticio", idempotency_key: key(),
      partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 100, precio_unitario: 360 }],
    });
    expect((await q(`select count(*)::int n from movimientos`))[0].n).toBe(antes);
  });
});

describe("Entregas parciales", () => {
  it("una entrega parcial no vuelve a descontar inventario y nunca se entrega más de lo vendido", async () => {
    const v = await rpc(s.cajeroA, "confirmar_venta", venta({}, [
      { producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 10, precio_unitario: 360, entregar_ahora: false },
    ], [{ forma: "efectivo", importe: 5000 }]));
    const tras = await stock(s.piso.id, s.almA);
    const pid = (await q(`select id from venta_partidas where venta_id=$1`, [v.venta_id]))[0].id;
    const pend = await q(`select pendiente_base from v_pendiente_entrega where almacen_id=$1 and producto_id=$2`, [s.almA, s.piso.id]);
    expect(Number(pend[0].pendiente_base)).toBeGreaterThanOrEqual(14.4);

    await rpc(s.cajeroA, "registrar_entrega", { venta_id: v.venta_id, idempotency_key: key(), partidas: [{ venta_partida_id: pid, cantidad: 4 }] });
    await rpc(s.cajeroA, "registrar_entrega", { venta_id: v.venta_id, idempotency_key: key(), partidas: [{ venta_partida_id: pid, cantidad: 6 }] });
    expect(await stock(s.piso.id, s.almA)).toBe(tras);
    await expect(rpc(s.cajeroA, "registrar_entrega", { venta_id: v.venta_id, idempotency_key: key(), partidas: [{ venta_partida_id: pid, cantidad: 1 }] }))
      .rejects.toThrow(/más de lo vendido/);
    const e = await q(`select count(*)::int n from entregas where venta_id=$1`, [v.venta_id]);
    expect(e[0].n).toBe(2);
  });
});

describe("Crédito", () => {
  it("venta a crédito valida cliente y límite", async () => {
    await expect(rpc(s.cajeroA, "confirmar_venta", venta({ tipo: "credito" }, undefined, []))).rejects.toThrow(/requiere un cliente/);
    const ok = await rpc(s.cajeroA, "confirmar_venta", venta({ tipo: "credito", cliente_id: s.clienteCredito }, [
      { producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 10, precio_unitario: 360 }], []));
    expect(Number(ok.saldo)).toBeGreaterThan(0);
    await expect(rpc(s.cajeroA, "confirmar_venta", venta({ tipo: "credito", cliente_id: s.clienteCredito }, [
      { producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 30, precio_unitario: 360 }], []))).rejects.toThrow(/límite de crédito/);
  });
});

describe("Seguridad (contra la base de datos)", () => {
  it("un cajero no puede vender, ajustar ni cancelar en otra sucursal", async () => {
    await expect(rpc(s.cajeroA, "confirmar_venta", venta({ sucursal_id: s.sucB, almacen_id: s.almB })))
      .rejects.toThrow(/No puedes vender en esta sucursal/);
    await expect(rpc(s.cajeroA, "registrar_ajuste", {
      almacen_id: s.almB, motivo: "x", idempotency_key: key(),
      partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.m2, cantidad: 5 }],
    })).rejects.toThrow(/No puedes ajustar/);
    const vB = await rpc(s.cajeroB, "confirmar_venta", venta({ sucursal_id: s.sucB, almacen_id: s.almB }));
    await expect(asUser(s.cajeroA, (c) => c.query(`select cancelar_venta($1, 'x')`, [vB.venta_id]))).rejects.toThrow(/sucursal|permiso/);
  });

  it("un cajero no puede modificar existencias, kardex ni ventas directamente", async () => {
    await expect(asUser(s.cajeroA, (c) => c.query(`update existencias set cantidad = 999 where almacen_id = $1`, [s.almB])))
      .rejects.toThrow(/permission denied/);
    await expect(asUser(s.cajeroA, (c) => c.query(`insert into movimientos (producto_id, almacen_id, tipo, cantidad, saldo, documento_tipo, documento_id)
                                                     values ($1,$2,'ajuste',1,1,'x',gen_random_uuid())`, [s.piso.id, s.almB])))
      .rejects.toThrow(/permission denied/);
    await expect(asUser(s.cajeroA, (c) => c.query(`update ventas set total = 0`))).rejects.toThrow(/permission denied/);
    await expect(asUser(s.cajeroA, (c) => c.query(`select mover_inventario($1,$2,100,'ajuste','x',gen_random_uuid(),0)`, [s.piso.id, s.almB])))
      .rejects.toThrow(/permission denied/);
    await expect(asUser(s.cajeroA, (c) => c.query(`select siguiente_folio($1,'venta')`, [s.sucB]))).rejects.toThrow(/permission denied/);
    await expect(asUser(s.cajeroA, (c) => c.query(`truncate movimientos`))).rejects.toThrow(/permission denied/);
    await expect(asUser(s.cajeroA, (c) => c.query(`select bloquear_existencias('[]'::jsonb)`))).rejects.toThrow(/permission denied/);
  });

  it("un usuario anónimo (sin sesión) no lee ni ejecuta nada", async () => {
    const c = await (await import("./setup")).pool.connect();
    try {
      await c.query("begin; set local role anon");
      await expect(c.query(`select * from productos limit 1`)).rejects.toThrow(/permission denied/);
    } finally { await c.query("rollback"); c.release(); }
    const c2 = await (await import("./setup")).pool.connect();
    try {
      await c2.query("begin; set local role anon");
      await expect(c2.query(`select confirmar_venta('{}'::jsonb)`)).rejects.toThrow(/permission denied/);
    } finally { await c2.query("rollback"); c2.release(); }
  });

  it("todos consultan existencias de todas las sucursales, pero solo ven ventas de las suyas", async () => {
    const ex = await asUser(s.cajeroA, async (c) => (await c.query(`select distinct almacen_id from existencias`)).rows.map((r) => r.almacen_id));
    expect(ex).toContain(s.almB);
    const vs = await asUser(s.cajeroA, async (c) => (await c.query(`select distinct sucursal_id from ventas`)).rows.map((r) => r.sucursal_id));
    expect(vs).toEqual([s.sucA]);
  });

  it("cambiar precio o aplicar descuento requiere permiso", async () => {
    await expect(rpc(s.cajeroA, "confirmar_venta", venta({}, [
      { producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 300 }])))
      .rejects.toThrow(/cambiar el precio/);
    await expect(rpc(s.cajeroA, "confirmar_venta", venta({}, [
      { producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360, descuento: 10 }])))
      .rejects.toThrow(/descuentos/);
  });
});

describe("Traspasos", () => {
  it("enviado -> en tránsito -> recibido mueve existencia entre almacenes", async () => {
    const oA = await stock(s.pisoCajas.id, s.almA), dB = await stock(s.pisoCajas.id, s.almB);
    const t = await rpc(s.almacenista, "enviar_traspaso", {
      almacen_origen: s.almA, almacen_destino: s.almB, idempotency_key: key(),
      partidas: [{ producto_id: s.pisoCajas.id, unidad_venta_id: s.pisoCajas.caja, cantidad: 5 }],
    });
    expect(await stock(s.pisoCajas.id, s.almA)).toBeCloseTo(oA - 7.2, 6);
    await asUser(s.almacenista, (c) => c.query(`select marcar_traspaso_en_transito($1)`, [t.traspaso_id]));
    // El almacenista de Centro no puede recibir en Norte
    await expect(rpc(s.almacenista, "recibir_traspaso", { traspaso_id: t.traspaso_id })).rejects.toThrow(/No puedes recibir/);
    await q(`insert into rol_permisos values ('cajero','traspasar') on conflict do nothing`);
    await rpc(s.cajeroB, "recibir_traspaso", { traspaso_id: t.traspaso_id });
    expect(await stock(s.pisoCajas.id, s.almB)).toBeCloseTo(dB + 7.2, 6);
    expect((await q(`select estado from traspasos where id=$1`, [t.traspaso_id]))[0].estado).toBe("recibido");
  });
});
