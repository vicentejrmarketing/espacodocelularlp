# Versão Cloudflare Pages

O mesmo repositório publica na Vercel (pasta `api/`) e no Cloudflare Pages (pasta `functions/`,
que chama as mesmas funções de `api/` através de `cloudflare/adaptador.js`).

## Configuração do projeto no Cloudflare Pages
- Repositório: `vicentejrmarketing/espacodocelularlp`, branch `main`
- Framework preset: **None**
- Build command: `bash cloudflare/build.sh`
- Build output directory: `dist` (também definido em `wrangler.toml`)
- Compatibilidade Node (`nodejs_compat`) e data de compatibilidade: definidas em `wrangler.toml`
- Segredos (Settings → Variables and Secrets, tipo **Secret**, em Production e Preview):
  - `CENTRAL_SUPABASE_KEY`
  - `CENTRAL_DB_SEGREDO`
- `CENTRAL_SUPABASE_URL` já está em `wrangler.toml`.

## Antes de ligar o domínio no Cloudflare
Aplicar `supabase/central_login.sql` no Supabase (projeto espaco-do-celular-central) e inserir os acessos
(resumo bcrypt). Sem isso o login da central usa a conferência antiga (scrypt), que passa do limite de
processamento do plano grátis do Cloudflare.

## O que não existe no Cloudflare Pages
- Agendador diário (`crons` do vercel.json) que reenvia cadastros ao CRM. Hoje o CRM não está ligado.

## Teste local
    bash cloudflare/build.sh
    npx wrangler@3 pages dev --port 8788 --binding CENTRAL_SUPABASE_URL=... --binding CENTRAL_SUPABASE_KEY=... --binding CENTRAL_DB_SEGREDO=...
    python3 tests/test_cloudflare.py
