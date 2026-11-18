-- =============================================================================
-- 0029 · Administrar almacenes: predeterminado por sucursal, renombrar, desactivar y eliminar
-- Solo el propietario de la cuenta. Se puede ejecutar más de una vez.
-- - Almacén predeterminado: el que se pone solo al capturar una venta en esa sucursal.
-- - Desactivar: solo si no tiene existencia (traspásala antes) y no es el predeterminado.
-- - Eliminar: solo si nunca se usó (sin movimientos ni documentos); si tiene historial, desactívalo.
-- =============================================================================
alter table public.sucursales add column if not exists almacen_predeterminado_id uuid references public.almacenes(id);

-- Para las sucursales existentes: el almacén de su caja (o el primero activo)
update public.sucursales s set almacen_predeterminado_id = coalesce(
    (select c.almacen_id from public.cajas c join public.almacenes a on a.id = c.almacen_id
      where c.sucursal_id = s.id and a.activo order by c.nombre limit 1),
    (select a.id from public.almacenes a where a.sucursal_id = s.id and a.activo order by a.nombre limit 1))
 where s.almacen_predeterminado_id is null;

-- {sucursal_id, almacen_id}
create or replace function public.almacen_predeterminado(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_al almacenes%rowtype; v_suc uuid := (p->>'sucursal_id')::uuid;
begin
  perform exigir(es_propietario(), 'Solo el propietario de la cuenta puede cambiar el almacén predeterminado');
  select * into v_al from almacenes where id = (p->>'almacen_id')::uuid;
  perform exigir(v_al.id is not null and v_al.activo, 'Almacén no válido o inactivo');
  perform exigir(v_al.sucursal_id = v_suc or v_al.multisucursal, 'El almacén debe ser de la sucursal (o multisucursal)');
  update sucursales set almacen_predeterminado_id = v_al.id where id = v_suc;
  -- Las cajas de la sucursal toman el mismo almacén
  update cajas set almacen_id = v_al.id where sucursal_id = v_suc;
  perform registrar_bitacora('almacen_predeterminado', 'sucursales', v_suc::text, null, p);
end $$;

-- {id, nombre?, activo?}
create or replace function public.actualizar_almacen(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_al almacenes%rowtype; v_existencia numeric;
begin
  perform exigir(es_propietario(), 'Solo el propietario de la cuenta puede modificar almacenes');
  select * into v_al from almacenes where id = (p->>'id')::uuid for update;
  perform exigir(v_al.id is not null, 'Almacén no encontrado');
  if p ? 'nombre' then
    perform exigir(length(trim(coalesce(p->>'nombre',''))) > 0, 'El nombre es obligatorio');
    update almacenes set nombre = trim(p->>'nombre') where id = v_al.id;
  end if;
  if p ? 'activo' and not (p->>'activo')::boolean and v_al.activo then
    perform exigir(not exists (select 1 from sucursales where almacen_predeterminado_id = v_al.id),
                   'Es el almacén predeterminado de una sucursal: elige otro predeterminado antes de desactivarlo');
    select coalesce(sum(abs(cantidad)), 0) + coalesce(sum(apartado), 0) into v_existencia from existencias where almacen_id = v_al.id;
    perform exigir(v_existencia = 0, 'El almacén todavía tiene existencia o material apartado: traspásalo o ajústalo antes de desactivarlo');
    update almacenes set activo = false where id = v_al.id;
  elsif p ? 'activo' and (p->>'activo')::boolean then
    update almacenes set activo = true where id = v_al.id;
  end if;
  perform registrar_bitacora('actualizar', 'almacenes', v_al.id::text, to_jsonb(v_al), p);
end $$;

create or replace function public.eliminar_almacen(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_al almacenes%rowtype;
begin
  perform exigir(es_propietario(), 'Solo el propietario de la cuenta puede eliminar almacenes');
  select * into v_al from almacenes where id = p_id for update;
  perform exigir(v_al.id is not null, 'Almacén no encontrado');
  perform exigir(not exists (select 1 from sucursales where almacen_predeterminado_id = p_id),
                 'Es el almacén predeterminado de una sucursal: elige otro predeterminado antes de eliminarlo');
  perform exigir(not exists (select 1 from movimientos where almacen_id = p_id),
                 'El almacén ya tiene movimientos de inventario y no se puede eliminar. Desactívalo.');
  perform exigir(not exists (select 1 from existencias where almacen_id = p_id and (cantidad <> 0 or apartado <> 0)),
                 'El almacén tiene existencia y no se puede eliminar.');
  delete from existencias where almacen_id = p_id;
  -- Las cajas que apuntaban a este almacén pasan al predeterminado de su sucursal
  update cajas c set almacen_id = s.almacen_predeterminado_id from sucursales s
   where c.almacen_id = p_id and s.id = c.sucursal_id and s.almacen_predeterminado_id is not null;
  begin
    delete from almacenes where id = p_id;
  exception when foreign_key_violation then
    raise exception 'El almacén ya se usó en ventas, traspasos u otros documentos y no se puede eliminar. Desactívalo.';
  end;
  perform registrar_bitacora('eliminar', 'almacenes', p_id::text, to_jsonb(v_al), null);
end $$;

revoke execute on function public.almacen_predeterminado(jsonb), public.actualizar_almacen(jsonb), public.eliminar_almacen(uuid) from public, anon;
grant execute on function public.almacen_predeterminado(jsonb), public.actualizar_almacen(jsonb), public.eliminar_almacen(uuid) to authenticated;

-- crear_sucursal (0014) no fija el predeterminado: un trigger lo pone al crear el primer almacén
create or replace function public.trg_almacen_predeterminado()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update sucursales set almacen_predeterminado_id = new.id where id = new.sucursal_id and almacen_predeterminado_id is null;
  return new;
end $$;
drop trigger if exists almacen_predeterminado on public.almacenes;
create trigger almacen_predeterminado after insert on public.almacenes
  for each row execute function public.trg_almacen_predeterminado();
