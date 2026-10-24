# Testes da integração LP → CRM → Cal.com

**Somente simulação.** Estes testes não usam o CRM, o armazenamento nem o Cal.com reais.
Passar aqui não comprova o funcionamento publicado nem a validação ponta a ponta.

## Requisitos
- Node 18+ (usa `fetch` nativo)
- Python 3.10+ com Playwright e Chromium: `pip install playwright && playwright install chromium`

## Executar
A partir da raiz do site:
```
python3 tests/test_integracao.py
```
Saída: uma linha `PASSOU`/`FALHOU` por verificação e `tests/resultado.json`. O código de saída é 0 só se tudo passar.

## O que é simulado
- `tests/simulador.js` sobe três serviços locais:
  1. o site e as funções `/api` (os mesmos arquivos que vão para a Vercel);
  2. um **receptor de cadastros** que segue o contrato informado pela equipe CRM: caminho
     `/api/v1/webhooks/pag-agendamento/{sourceId}/cadastro`, `X-Pag-Agendamento-Signature` (HMAC-SHA256 hex
     sem prefixo sobre os bytes), recusa de chaves repetidas, 64 KiB, respostas 200/400/401/404/409/413/429/503,
     confirmação em `data` e deduplicação por `external_id`. Ele também gera respostas inválidas de propósito
     (HTML, `persisted:false`, `"true"` textual, id divergente, só `ok:true`, JSON inválido, resposta lenta);
  3. um **armazenamento chave-valor REST** no formato Redis, que executa os scripts atômicos do código.
     No armazenamento real, o suporte a `EVAL` precisa ser comprovado.
- `tests/fixtures/calcom-embed-core-1.5.3.js` é o script oficial do pop-up do Cal.com, do pacote npm
  `@calcom/embed-core` 1.5.3. O conteúdo da agenda (iframe) é substituído por uma página vazia.

Todos os valores são fictícios: segredo, token, UUID da fonte, nomes e telefones. Nenhuma mensagem é enviada.
