-- Central de leads da Espaço do Celular (Supabase / Postgres)
-- Tabelas num schema PRIVADO (não exposto pela API). O site acessa só por funções que exigem
-- o segredo do servidor (variável CENTRAL_DB_SEGREDO da Vercel), gravado em central_priv.config.
-- Nenhuma senha de loja fica no banco.

create schema if not exists central_priv;
revoke all on schema central_priv from public;

create table if not exists central_priv.config (
  chave text primary key,
  valor text not null
);

create table if not exists central_priv.leads (
  id text primary key,
  loja text not null,
  dados jsonb not null,
  criado_em timestamptz not null default now(),
  clicou_whatsapp_em timestamptz
);
create index if not exists leads_loja_criado on central_priv.leads (loja, criado_em desc);

create table if not exists central_priv.cliques (
  loja text not null,
  dia date not null,
  origem text not null check (origem in ('site', 'pre-analise')),
  total integer not null default 0,
  primary key (loja, dia, origem)
);

create table if not exists central_priv.dedupe (
  chave text primary key,
  expira timestamptz not null
);

create table if not exists central_priv.tentativas (
  chave text primary key,
  n integer not null,
  expira timestamptz not null
);

alter table central_priv.config enable row level security;
alter table central_priv.leads enable row level security;
alter table central_priv.cliques enable row level security;
alter table central_priv.dedupe enable row level security;
alter table central_priv.tentativas enable row level security;

-- confere o segredo do servidor
create or replace function central_priv.autorizado(p_segredo text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(length(p_segredo) >= 32, false)
     and exists (select 1 from central_priv.config c where c.chave = 'segredo' and c.valor = p_segredo);
$$;
revoke all on function central_priv.autorizado(text) from public;

-- grava o lead uma única vez por id (reenvio do mesmo formulário não duplica)
create or replace function public.central_salvar_lead(p_segredo text, p_lead jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not central_priv.autorizado(p_segredo) then raise exception 'nao_autorizado'; end if;
  insert into central_priv.leads (id, loja, dados, criado_em)
  values (p_lead->>'id', p_lead->>'loja', p_lead, coalesce((p_lead->>'criado_em')::timestamptz, now()))
  on conflict (id) do nothing;
  return found;
end;
$$;

-- conta um clique no botão de WhatsApp (repetido do mesmo aparelho em 3 s conta uma vez)
create or replace function public.central_clique(p_segredo text, p_loja text, p_origem text, p_dedupe text, p_lead_id text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agora timestamptz := now();
begin
  if not central_priv.autorizado(p_segredo) then raise exception 'nao_autorizado'; end if;
  if p_origem not in ('site', 'pre-analise') then return 'invalido'; end if;

  delete from central_priv.dedupe where chave in (select chave from central_priv.dedupe where expira < v_agora limit 200);
  insert into central_priv.dedupe as d (chave, expira) values (p_dedupe, v_agora + interval '3 seconds')
  on conflict (chave) do update set expira = excluded.expira where d.expira < v_agora;
  if not found then return 'repetido'; end if;

  insert into central_priv.cliques as c (loja, dia, origem, total)
  values (p_loja, (v_agora at time zone 'America/Sao_Paulo')::date, p_origem, 1)
  on conflict (loja, dia, origem) do update set total = c.total + 1;

  if coalesce(p_lead_id, '') <> '' then
    update central_priv.leads set clicou_whatsapp_em = v_agora
     where id = p_lead_id and loja = p_loja and clicou_whatsapp_em is null;
  end if;
  return 'ok';
end;
$$;

-- tentativas de login: 'ver' | 'erro' | 'limpar' (10 erros em 15 min bloqueiam)
create or replace function public.central_tentativas(p_segredo text, p_chave text, p_acao text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v integer;
begin
  if not central_priv.autorizado(p_segredo) then raise exception 'nao_autorizado'; end if;
  if p_acao = 'ver' then
    select n into v from central_priv.tentativas where chave = p_chave and expira > now();
    return coalesce(v, 0);
  elsif p_acao = 'erro' then
    insert into central_priv.tentativas as t (chave, n, expira) values (p_chave, 1, now() + interval '15 minutes')
    on conflict (chave) do update
      set n = case when t.expira < now() then 1 else t.n + 1 end,
          expira = now() + interval '15 minutes'
    returning n into v;
    return v;
  elsif p_acao = 'limpar' then
    delete from central_priv.tentativas where chave = p_chave;
    return 0;
  end if;
  return 0;
end;
$$;

-- dados da central: leads e cliques SÓ das lojas pedidas pelo servidor (que já verificou o login)
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
                 l.dados || case when l.clicou_whatsapp_em is null then '{}'::jsonb
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

revoke all on function public.central_salvar_lead(text, jsonb) from public;
revoke all on function public.central_clique(text, text, text, text, text) from public;
revoke all on function public.central_tentativas(text, text, text) from public;
revoke all on function public.central_dados(text, text[], integer) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.central_salvar_lead(text, jsonb) to anon, authenticated, service_role;
    grant execute on function public.central_clique(text, text, text, text, text) to anon, authenticated, service_role;
    grant execute on function public.central_tentativas(text, text, text) to anon, authenticated, service_role;
    grant execute on function public.central_dados(text, text[], integer) to anon, authenticated, service_role;
  end if;
end $$;
