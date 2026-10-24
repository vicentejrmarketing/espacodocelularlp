// API da central de leads.
//   POST /api/central            {"email":"...","senha":"..."}      -> {ok, token, acesso}
//   GET  /api/central            Authorization: Bearer <token>       -> leads e cliques SÓ da loja do token
// O token é assinado no servidor; a loja vem do token, nunca de um parâmetro que o navegador possa trocar.

const { getStore } = require("./_store");
const { entrar, verificar, dados, ipDe } = require("./_central");

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  res.end(JSON.stringify(body));
}

async function lerCorpo(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  let s = "";
  for await (const c of req) {
    s += c;
    if (s.length > 4000) throw new Error("grande");
  }
  return JSON.parse(s || "{}");
}

module.exports = async function (req, res) {
  const env = process.env;
  const store = getStore(env);
  if (!store) return json(res, 503, { ok: false, erro: "armazenamento_nao_configurado" });
  try {
    if (req.method === "POST") {
      let b;
      try {
        b = await lerCorpo(req);
      } catch (e) {
        return json(res, 400, { ok: false, erro: "corpo_invalido" });
      }
      const r = await entrar(store, env, { email: String(b.email || "").slice(0, 200), senha: String(b.senha || "").slice(0, 200), ip: ipDe(req) });
      if (!r.ok) return json(res, r.status, { ok: false, erro: r.erro });
      return json(res, 200, { ok: true, token: r.token, acesso: r.acesso });
    }
    if (req.method === "GET") {
      const auth = String(req.headers.authorization || "");
      const acesso = verificar(env, auth.startsWith("Bearer ") ? auth.slice(7) : "");
      if (!acesso) return json(res, 401, { ok: false, erro: "sessao_invalida" });
      return json(res, 200, Object.assign({ ok: true }, await dados(store, acesso)));
    }
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { ok: false, erro: "metodo" });
  } catch (e) {
    console.error(JSON.stringify({ evento: "central", estado: "armazenamento_indisponivel", nivel: "alerta" }));
    return json(res, 503, { ok: false, erro: "armazenamento_indisponivel" });
  }
};
