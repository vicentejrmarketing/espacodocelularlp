// Agendador e operação da fila de cadastros.
// Autenticação: "Authorization: Bearer <CRON_SECRET>" (credencial própria do agendador, só no servidor).
//
//   GET  /api/cadastro-reprocessar                          execução periódica (a cada 2–5 min): reenvia vencidos,
//                                                          respeitando o backoff de cada registro; sem sobreposição
//   GET  /api/cadastro-reprocessar?resumo=1                 contagens, idade da pendência mais antiga, última execução
//   POST /api/cadastro-reprocessar?reativar=<id>|1          devolve falha(s) permanente(s) à fila após a correção
//   POST /api/cadastro-reprocessar?descartar=<id>&confirmar=1  descarte explícito (apaga dados pessoais do registro)

const { getStore } = require("./_store");
const { executarAgendador, reprocessarVencidos, reativarFalhas, descartar, resumo } = require("./_processar");

function responder(res, status, corpo) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(corpo));
}

module.exports = async function (req, res) {
  const segredo = process.env.CRON_SECRET;
  if (!segredo || req.headers.authorization !== "Bearer " + segredo) return responder(res, 401, { ok: false, erro: "nao_autorizado" });
  const store = getStore(process.env);
  if (!store) {
    console.error(JSON.stringify({ evento: "fila_cadastros", nivel: "alerta", estado: "armazenamento_nao_configurado" }));
    return responder(res, 503, { ok: false, erro: "armazenamento_nao_configurado" });
  }
  const q = new URL(req.url, "http://x").searchParams;
  try {
    if (q.get("resumo")) return responder(res, 200, Object.assign({ ok: true }, await resumo(store)));

    if (q.get("reativar")) {
      if (req.method !== "POST") return responder(res, 405, { ok: false, erro: "use_post" });
      const reativados = await reativarFalhas(store, q.get("reativar") === "1" ? null : [q.get("reativar")]);
      const feitos = await reprocessarVencidos(store, process.env, { limite: 25, orcamentoMs: 8000 });
      return responder(res, 200, { ok: true, reativados: reativados.length, resultado: feitos });
    }

    if (q.get("descartar")) {
      if (req.method !== "POST" || q.get("confirmar") !== "1") return responder(res, 400, { ok: false, erro: "use_post_com_confirmar_1" });
      return responder(res, 200, { ok: true, descartado: await descartar(store, q.get("descartar")) });
    }

    const r = await executarAgendador(store, process.env, { limite: 25, orcamentoMs: 20000 });
    if (r.sobreposicao) return responder(res, 200, { ok: true, ignorado: "execucao_anterior_em_andamento" });
    const s = await resumo(store);
    if (s.falhas_permanentes > 0 || s.pendente_mais_antigo_min > 30) {
      console.error(JSON.stringify({ evento: "fila_cadastros", nivel: "alerta", falhas_permanentes: s.falhas_permanentes, pendentes: s.pendentes, pendente_mais_antigo_min: s.pendente_mais_antigo_min, falha_mais_antiga_min: s.falha_mais_antiga_min }));
    }
    return responder(res, 200, { ok: true, processados: r.feitos.length, resultado: r.feitos, pendentes: s.pendentes, falhas_permanentes: s.falhas_permanentes });
  } catch (e) {
    console.error(JSON.stringify({ evento: "fila_cadastros", nivel: "alerta", estado: "armazenamento_indisponivel" }));
    return responder(res, 503, { ok: false, erro: "armazenamento_indisponivel" });
  }
};
