-- =============================================================================
-- 0011 · Varios logotipos en el encabezado de la remisión (p. ej. marcas que se distribuyen)
-- Se guardan como arreglo JSON de data URLs (PNG/JPEG), máximo 6.
-- =============================================================================

create or replace function public.logos_validos(p jsonb)
returns boolean language sql immutable as $$
  select jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) <= 6
     and length(p::text) <= 3000000
     and not exists (select 1 from jsonb_array_elements(p) x
                     where jsonb_typeof(x) <> 'string' or (x #>> '{}') !~ '^data:image/(png|jpeg);base64,')
$$;

alter table public.empresa
  add column logos jsonb not null default '[]'::jsonb check (public.logos_validos(logos));

-- El logotipo único anterior pasa a ser el primero de la lista
update public.empresa set logos = jsonb_build_array(logo) where logo is not null and logos = '[]'::jsonb;

-- La validación se ejecuta con el usuario que guarda: debe poder llamarla (es de solo lectura)
revoke execute on function public.logos_validos(jsonb) from public, anon;
grant execute on function public.logos_validos(jsonb) to authenticated;
