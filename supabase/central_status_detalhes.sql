-- Detalhes obrigatórios do status:
--   recusado -> motivo da recusa
--   comprou  -> o que comprou + valor
alter table central_priv.leads add column if not exists motivo_recusa text;
alter table central_priv.leads add column if not exists compra_produto text;
alter table central_priv.leads add column if not exists compra_valor numeric(12,2);

drop function if exists public.central_status(text, text, text[], text, text);

create or replace function public.central_status(
  p_segredo text, p_id text, p_lojas text[], p_status text, p_por text,
  p_motivo text, p_produto text, p_valor numeric
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_motivo text := nullif(btrim(coalesce(p_motivo, '')), '');
  v_produto text := nullif(btrim(coalesce(p_produto, '')), '');
begin
  if not central_priv.autorizado(p_segredo) then raise exception 'nao_autorizado'; end if;
  if p_status not in ('novo', 'em_atendimento', 'recusado', 'comprou') then return false; end if;
  -- mesmas regras do servidor, repetidas aqui por segurança
  if p_status = 'recusado' and (v_motivo is null or length(v_motivo) < 3) then return false; end if;
  if p_status = 'comprou' and (v_produto is null or length(v_produto) < 2 or p_valor is null or p_valor <= 0 or p_valor > 1000000) then return false; end if;
  update central_priv.leads
     set status = p_status,
         status_em = now(),
         status_por = left(coalesce(p_por, ''), 40),
         motivo_recusa = case when p_status = 'recusado' then left(v_motivo, 500) else null end,
         compra_produto = case when p_status = 'comprou' then left(v_produto, 200) else null end,
         compra_valor = case when p_status = 'comprou' then round(p_valor, 2) else null end
   where id = p_id and loja = any(p_lojas);
  return found;
end;
$$;
revoke all on function public.central_status(text, text, text[], text, text, text, text, numeric) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.central_status(text, text, text[], text, text, text, text, numeric) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.central_status(text, text, text[], text, text, text, text, numeric) to anon;
  end if;
end $$;

create or replace function public.central_dados(p_segredo text, p_lojas text[], p_dias integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if not central_priv.autorizado(p_segredo) then raise exception 'nao_autorizado'; end if;
  return jsonb_build_object(
    'leads', coalesce((
      select jsonb_agg(x.j order by x.criado_em desc)
        from (
          select l.criado_em,
                 l.dados
                 || jsonb_build_object('status', l.status)
                 || jsonb_strip_nulls(jsonb_build_object(
                      'status_em', to_char(l.status_em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                      'status_por', l.status_por,
                      'motivo_recusa', l.motivo_recusa,
                      'compra_produto', l.compra_produto,
                      'compra_valor', l.compra_valor,
                      'clicou_whatsapp_em', to_char(l.clicou_whatsapp_em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) as j
            from central_priv.leads l
           where l.loja = any(p_lojas)
           order by l.criado_em desc
           limit 2000
        ) x
    ), '[]'::jsonb),
    'totais', coalesce((
      select jsonb_agg(jsonb_build_object('loja', c.loja, 'origem', c.origem, 'total', c.total))
        from (select loja, origem, sum(total)::int as total from central_priv.cliques
               where loja = any(p_lojas) group by loja, origem) c
    ), '[]'::jsonb),
    'dias', coalesce((
      select jsonb_agg(jsonb_build_object('loja', c.loja, 'dia', to_char(c.dia, 'YYYY-MM-DD'), 'origem', c.origem, 'total', c.total))
        from central_priv.cliques c
       where c.loja = any(p_lojas) and c.dia > v_hoje - greatest(p_dias, 1)
    ), '[]'::jsonb)
  );
end;
$$;
