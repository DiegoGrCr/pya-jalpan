-- =============================================================================
-- Conteo físico: se captura lo contado de cada producto y, al guardar, el sistema compara contra la
-- existencia de ese momento (bloqueada) y registra un ajuste (origen 'conteo') solo por las diferencias.
-- p = {almacen_id, motivo?, idempotency_key, partidas:[{producto_id, contado_base}]}
-- Además: toda sucursal con serie de traspasos (código+T) y de ajustes (código+A).
-- Se puede ejecutar más de una vez.
-- =============================================================================
insert into public.series (sucursal_id, tipo_documento, prefijo)
select su.id, t.tipo, su.codigo || t.letra from public.sucursales su
 cross join (values ('traspaso','T'), ('ajuste','A')) as t(tipo, letra)
 where not exists (select 1 from public.series se where se.sucursal_id = su.id and se.tipo_documento = t.tipo);

create or replace function public.registrar_conteo(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_al almacenes%rowtype; r record; v_part jsonb := '[]'; v_det jsonb := '[]'; v_ex uuid; v_res jsonb;
begin
  perform exigir(length(coalesce(p->>'idempotency_key','')) >= 8, 'Falta la clave de idempotencia');
  select id into v_ex from ajustes where idempotency_key = p->>'idempotency_key';
  if v_ex is not null then return jsonb_build_object('ajuste_id', v_ex, 'repetida', true); end if;
  select * into v_al from almacenes where id = nullif(p->>'almacen_id','')::uuid;
  perform exigir(v_al.id is not null, 'Almacén no encontrado');
  perform exigir(opera_almacen(v_al.id), 'No puedes contar este almacén');
  perform exigir(tiene_permiso('ajustar_inventario'), 'No tienes permiso para ajustar inventario');
  perform exigir(jsonb_array_length(coalesce(p->'partidas','[]')) > 0, 'No capturaste ningún producto');

  perform bloquear_existencias((select coalesce(jsonb_agg(jsonb_build_object('producto_id', x->>'producto_id', 'almacen_id', v_al.id)), '[]')
                                  from jsonb_array_elements(p->'partidas') x));
  for r in select pr.id producto_id, pr.nombre, (x->>'contado_base')::numeric contado,
                  coalesce((select e.cantidad from existencias e where e.producto_id = pr.id and e.almacen_id = v_al.id), 0) existencia,
                  (select u.id from unidades_venta u where u.producto_id = pr.id and u.es_base) unidad_base
             from jsonb_array_elements(p->'partidas') x join productos pr on pr.id = (x->>'producto_id')::uuid
            where pr.tipo = 'producto' loop
    perform exigir(r.contado is not null and r.contado >= 0, r.nombre || ': lo contado no es válido');
    v_det := v_det || jsonb_build_object('producto_id', r.producto_id, 'producto', r.nombre, 'existencia', r.existencia, 'contado', r.contado, 'diferencia', r.contado - r.existencia);
    if r.contado <> r.existencia then
      v_part := v_part || jsonb_build_object('producto_id', r.producto_id, 'unidad_venta_id', r.unidad_base, 'cantidad', r.contado - r.existencia);
    end if;
  end loop;

  if jsonb_array_length(v_part) = 0 then
    return jsonb_build_object('sin_diferencias', true, 'detalle', v_det);
  end if;
  v_res := registrar_ajuste(jsonb_build_object('almacen_id', v_al.id, 'origen', 'conteo', 'idempotency_key', p->>'idempotency_key',
             'motivo', coalesce(nullif(trim(p->>'motivo'), ''), 'Conteo físico'), 'partidas', v_part));
  return v_res || jsonb_build_object('sin_diferencias', false, 'detalle', v_det);
end $$;

revoke execute on function public.registrar_conteo(jsonb) from public, anon;
grant execute on function public.registrar_conteo(jsonb) to authenticated;
