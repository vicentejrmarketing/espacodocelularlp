-- Status de atendimento de cada lead: novo | em_atendimento | recusado | comprou
alter table central_priv.leads add column if not exists status text not null default 'novo';
alter table central_priv.leads add column if not exists status_em timestamptz;
alter table central_priv.leads add column if not exists status_por text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_status_valido') then
    alter table central_priv.leads add constraint leads_status_valido check (status in ('novo', 'em_atendimento', 'recusado', 'comprou'));
  end if;
end $$;

-- Atualiza o status. Só altera lead de uma das lojas permitidas (o servidor manda as lojas do login).
create or replace function public.central_status(p_segredo text, p_id text, p_lojas text[], p_status text, p_por text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not central_priv.autorizado(p_segredo) then raise exception 'nao_autorizado'; end if;
  if p_status not in ('novo', 'em_atendimento', 'recusado', 'comprou') then return false; end if;
  update central_priv.leads
     set status = p_status, status_em = now(), status_por = left(coalesce(p_por, ''), 40)
   where id = p_id and loja = any(p_lojas);
  return found;
end;
$$;
revoke all on function public.central_status(text, text, text[], text, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.central_status(text, text, text[], text, text) to anon;
  end if;
end $$;

-- Leitura passa a devolver o status de cada lead
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
                 || case when l.status_em is null then '{}'::jsonb
                      else jsonb_build_object('status_em', to_char(l.status_em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'status_por', l.status_por) end
                 || case when l.clicou_whatsapp_em is null then '{}'::jsonb
                      else jsonb_build_object('clicou_whatsapp_em', to_char(l.clicou_whatsapp_em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) end as j
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
