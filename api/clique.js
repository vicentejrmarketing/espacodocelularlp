// Conta cliques nos botões de WhatsApp das lojas (chamado pela página com navigator.sendBeacon).
// Corpo: {"loja":"itajai","origem":"site"|"pre-analise","id":"<external_id opcional>"}
// Não grava IP: o endereço só entra num resumo (hash) de 3 segundos para não contar clique duplo.

const { registrarClique, ipDe, base } = require("./_central");

async function lerCorpo(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8") || "{}");
  let s = "";
  for await (const c of req) {
    s += c;
    if (s.length > 2000) throw new Error("grande");
  }
  return JSON.parse(s || "{}");
}

module.exports = async function (req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  let b;
  try {
    b = await lerCorpo(req);
  } catch (e) {
    res.statusCode = 400;
    return res.end();
  }
  if (!base(process.env)) {
    console.error(JSON.stringify({ evento: "central_cliques", estado: "armazenamento_nao_configurado", nivel: "alerta" }));
    res.statusCode = 503;
    return res.end();
  }
  try {
    const r = await registrarClique(process.env, {
      loja: String(b.loja || "").toLowerCase(),
      origem: String(b.origem || ""),
      id: b.id ? String(b.id).slice(0, 200) : "",
      ip: ipDe(req),
    });
    res.statusCode = r.ok ? 204 : 422;
    return res.end();
  } catch (e) {
    console.error(JSON.stringify({ evento: "central_cliques", estado: "armazenamento_indisponivel", nivel: "alerta" }));
    res.statusCode = 503;
    return res.end();
  }
};
