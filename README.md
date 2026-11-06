# Espaço do Celular — cópia do site (branch `site-copia`)

Cópia da landing page, publicada num projeto próprio da Vercel. Não afeta o site original (branch `main`).

- `index.html` — página principal, com o formulário de pré-análise logo após o primeiro bloco
- `analise.html` — tela "Analisando seus dados"
- `aprovado.html` — tela "Perfil pré-aprovado" com o botão do vendedor (WhatsApp 47 99915-1352)
- `leads.html` — lista de leads, protegida por senha (botão "Acessar leads" no fim da página)
- `pa.js` — lógica do formulário; grava os leads no Supabase (projeto central-de-trafego-sp, tabela leads_site)
- `lojas.js` — lista das lojas
- `videos/` — vídeos de depoimentos

Os leads só podem ser gravados pela chave pública; ler exige a senha (função listar_leads). A senha não fica neste repositório.
