-- =============================================================================
-- 0035 · Los pisos sin categoría quedan en la categoría "Pisos"
-- Al importar la hoja, las pestañas de pisos se tomaron como MARCA y los pisos quedaron sin categoría.
-- 1) Se asigna "Pisos" a los pisos existentes sin categoría.
-- 2) Un trigger lo hace en adelante (alta, edición o importación) si un piso llega sin categoría.
-- Se puede ejecutar más de una vez.
-- =============================================================================
insert into public.categorias (nombre)
select 'Pisos' where not exists (select 1 from public.categorias where padre_id is null and lower(nombre) = 'pisos');

update public.productos set categoria_id = (select id from public.categorias where padre_id is null and lower(nombre) = 'pisos' limit 1)
 where presentacion = 'piso' and categoria_id is null;

create or replace function public.trg_piso_categoria()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.presentacion = 'piso' and new.categoria_id is null then
    new.categoria_id := categoria_por_nombre('Pisos');
  end if;
  return new;
end $$;
drop trigger if exists piso_categoria on public.productos;
create trigger piso_categoria before insert or update of presentacion, categoria_id on public.productos
  for each row execute function public.trg_piso_categoria();
