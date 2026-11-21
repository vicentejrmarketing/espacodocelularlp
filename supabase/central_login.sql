-- Acessos da central conferidos no banco (bcrypt via pgcrypto).
-- Assim a conferência da senha não gasta processamento do servidor do site
-- (necessário no Cloudflare, que limita o processamento por acesso; vale também na Vercel).
create extension if not exists pgcrypto with schema extensions;

create table if not exists central_priv.acessos (
  usuario text primary key,          -- e-mail da loja (minúsculo) ou "gerente"
  acesso text not null,              -- código da loja ou "geral"
  senha_hash text not null,          -- bcrypt ($2a$...)
  ativo boolean not null default true
);
alter table central_priv.acessos enable row level security;

-- Devolve o acesso (loja ou "geral") se usuário e senha conferem; senão null.
create or replace function public.central_login(p_segredo text, p_usuario text, p_senha text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_acesso text;
  v_hash text;
begin
  if not central_priv.autorizado(p_segredo) then raise exception 'nao_autorizado'; end if;
  select a.acesso, a.senha_hash into v_acesso, v_hash
    from central_priv.acessos a
   where a.usuario = lower(btrim(coalesce(p_usuario, ''))) and a.ativo;
  if v_hash is null then
    -- mesmo custo para usuário inexistente (não revela quais usuários existem)
    perform extensions.crypt(coalesce(p_senha, ''), '$2a$10$abcdefghijklmnopqrstuuJ5j0O1m2qG0r8m0kC3Z1eF7wqW3a6Fy');
    return null;
  end if;
  if extensions.crypt(coalesce(p_senha, ''), v_hash) = v_hash then return v_acesso; end if;
  return null;
end;
$$;
revoke all on function public.central_login(text, text, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.central_login(text, text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.central_login(text, text, text) to anon;
  end if;
end $$;

-- Os acessos (com o resumo bcrypt) são inseridos à parte, nunca com a senha escrita:
-- insert into central_priv.acessos (usuario, acesso, senha_hash) values ('email@loja.com', 'itajai', '$2a$10$...')
--   on conflict (usuario) do update set acesso = excluded.acesso, senha_hash = excluded.senha_hash, ativo = true;
-- Para gerar o resumo de uma senha nova:  python3 -c "import bcrypt;print(bcrypt.hashpw(b'NovaSenha',bcrypt.gensalt(10)).decode().replace('\$2b\$','\$2a\$',1))"
