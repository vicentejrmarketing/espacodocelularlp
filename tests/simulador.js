// Simulador local para testes: site + funções /api + receptor CRM conforme contrato + armazenamento KV REST.
// Uso: node tests/simulador.js <raiz-do-site> <porta> [kv]
// NÃO é o CRM real nem o armazenamento real. Serve para testes reproduzíveis sem dependências externas.
process.on("uncaughtException", (e) => console.error("ERRO", e && e.stack));
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = path.resolve(process.argv[2]), PORT = +process.argv[3], USA_KV = process.argv[4] === "kv";
const SOURCE = "00000000-0000-4000-8000-0000000000aa";
const SEGREDO = "segredo-cadastro-de-teste";

// ---------------- Receptor CRM simulado (contrato pag-agendamento) ----------------
const crm = { modo: "ok", recebidos: [], guardados: new Map() }; // guardados: external_id -> {hash, receipt}
function corpoParse(raw, ct) {
  if (/json/.test(ct)) return { obj: JSON.parse(raw) };
  const p = new URLSearchParams(raw), obj = {}, rep = [];
  for (const [k, v] of p) { if (k in obj) rep.push(k); obj[k] = v; }
  return { obj, rep };
}
http.createServer((req, res) => {
  const u = req.url;
  if (u.startsWith("/__modo/")) { crm.modo = u.split("/")[2]; return res.end("ok"); }
  if (u === "/__log") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ recebidos: crm.recebidos, guardados: crm.guardados.size })); }
  if (u === "/__reset") { crm.recebidos = []; crm.guardados.clear(); return res.end("ok"); }
  const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
    const bytes = Buffer.concat(chunks), raw = bytes.toString("utf8"), ct = req.headers["content-type"] || "";
    const m = /^\/api\/v1\/webhooks\/pag-agendamento\/([^/]+)\/cadastro$/.exec(u);
    const assin = req.headers["x-pag-agendamento-signature"];
    const esperado = crypto.createHmac("sha256", SEGREDO).update(bytes).digest("hex");
    let st = 200, body = null, obj = {}, rep = [];
    try { ({ obj, rep = [] } = corpoParse(raw, ct)); } catch (e) { st = 400; }
    if (!m || m[1] !== SOURCE) st = 404;
    else if (bytes.length > 65536) st = 413;
    else if (assin !== esperado) st = 401;
    else if (rep.length) st = 400;
    else if (crm.modo === "falha") st = 503;
    else if (crm.modo === "limite") st = 429;
    else if (crm.modo === "auth") st = 401;
    else if (crm.modo === "desligada") st = 404;
    const reg = { hora: Date.now(), status: st, modo: crm.modo, assinatura_valida: assin === esperado, assinatura_hex_sem_prefixo: /^[0-9a-f]{64}$/.test(assin || ""), raw, idem: req.headers["idempotency-key"], ct, body: obj, repetidas: rep };
    if (st === 200) {
      const id = obj.external_id, hash = crypto.createHash("sha256").update(JSON.stringify([obj.nome, obj.telefone, obj.loja, obj.cpf || ""])).digest("hex");
      const g = crm.guardados.get(id);
      if (g && g.hash !== hash) st = 409;
      else {
        if (!g) crm.guardados.set(id, { hash, receipt: crypto.randomUUID(), aplicacoes: 1 });
        const r = crm.guardados.get(id);
        reg.repeticao = !!g;
        const data = { external_id: id, persisted: true, receipt_id: r.receipt, submission_id: r.receipt, lead_id: null, status: "pending_mapping" };
        if (crm.modo === "html200") body = ["text/html", "<html>ok</html>"];
        else if (crm.modo === "persisted_false") body = ["application/json", JSON.stringify({ data: { ...data, persisted: false } })];
        else if (crm.modo === "persisted_texto") body = ["application/json", JSON.stringify({ data: { ...data, persisted: "true" } })];
        else if (crm.modo === "id_divergente") body = ["application/json", JSON.stringify({ data: { ...data, external_id: id + "x" } })];
        else if (crm.modo === "so_ok") body = ["application/json", JSON.stringify({ ok: true })];
        else if (crm.modo === "raiz") body = ["application/json", JSON.stringify(data)];
        else if (crm.modo === "json_invalido") body = ["application/json", "{data:"];
        else body = ["application/json", JSON.stringify({ data })];
      }
    }
    reg.status = st; crm.recebidos.push(reg);
    const fim = () => { res.statusCode = st; if (body) { res.setHeader("content-type", body[0]); res.end(body[1]); } else res.end(st === 409 ? '{"error":"conflict"}' : "erro"); };
    if (crm.modo === "lento") setTimeout(fim, 3000); else fim();
  });
}).listen(PORT + 1);

// ---------------- Armazenamento KV simulado (REST no formato Redis) ----------------
const { LUA_REGISTRAR, LUA_ATUALIZAR } = require(path.join(ROOT, "api", "_processar.js"));
const LUA_DESTRAVAR = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";
const kv = { str: new Map(), exp: new Map(), z: new Map(), h: new Map(), off: false, comandos: {} };
const vivo = (k) => { const e = kv.exp.get(k); if (e && e < Date.now()) { kv.str.delete(k); kv.exp.delete(k); } return kv.str.has(k); };
const zadd = (k, s, m) => { if (!kv.z.has(k)) kv.z.set(k, new Map()); kv.z.get(k).set(m, +s); };
const zrem = (k, m) => kv.z.has(k) && kv.z.get(k).delete(m);
function setk(k, v, ex) { kv.str.set(k, v); if (ex) kv.exp.set(k, Date.now() + +ex * 1000); else kv.exp.delete(k); }
http.createServer((req, res) => {
  if (req.url === "/__off") { kv.off = true; return res.end("ok"); }
  if (req.url === "/__on") { kv.off = false; return res.end("ok"); }
  if (req.url === "/__vencer") { for (const z of kv.z.values()) for (const m of z.keys()) z.set(m, 0); return res.end("ok"); }
  if (req.url === "/__dump") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ comandos: kv.comandos, expira: Object.fromEntries(kv.exp), chaves: [...kv.str.keys()].filter(vivo).filter((k) => k.includes(":cad:")).map((k) => [k, JSON.parse(kv.str.get(k))]), filas: Object.fromEntries([...kv.z].map(([k, v]) => [k, [...v.keys()]])) })); }
  if (kv.off) { res.statusCode = 500; return res.end('{"error":"down"}'); }
  if (req.headers.authorization !== "Bearer token-kv-teste") { res.statusCode = 401; return res.end('{"error":"unauthorized"}'); }
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    if (req.url === "/pipeline") {
      const out = []; for (const a of JSON.parse(b)) { const x = executar(a); if (x.erro) out.push({ error: x.erro }); else out.push({ result: x.r }); }
      res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(out));
    }
    const x = executar(JSON.parse(b));
    if (x.erro) { res.statusCode = 400; return res.end(JSON.stringify({ error: x.erro })); }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ result: x.r }));
  });
}).listen(PORT + 2);
function executar(a) {
    const c = a[0].toUpperCase(); let r = null;
    const cont = String(a[1] || "").startsWith("edc:central:") ? c + "_central" : c; // central de leads contada à parte
    kv.comandos[cont] = (kv.comandos[cont] || 0) + 1;
    if (c === "GET") r = vivo(a[1]) ? kv.str.get(a[1]) : null;
    else if (c === "SET") { const nx = a.includes("NX"), ei = a.indexOf("EX"); if (nx && vivo(a[1])) r = null; else { setk(a[1], a[2], ei > 0 ? a[ei + 1] : null); r = "OK"; } }
    else if (c === "DEL") r = kv.str.delete(a[1]) ? 1 : 0;
    else if (c === "ZADD") { zadd(a[1], a[2], a[3]); r = 1; }
    else if (c === "ZREM") r = zrem(a[1], a[2]) ? 1 : 0;
    else if (c === "ZRANGE") { const z = kv.z.get(a[1]) || new Map(); const arr = [...z].sort((x, y) => x[1] - y[1]).slice(+a[2], +a[3] + 1); r = a.includes("WITHSCORES") ? arr.flatMap((x) => [x[0], String(x[1])]) : arr.map((x) => x[0]); }
    else if (c === "ZRANGEBYSCORE") { const z = kv.z.get(a[1]) || new Map(); r = [...z].filter(([, s]) => s <= +a[3]).sort((x, y) => x[1] - y[1]).map((x) => x[0]).slice(+a[5], +a[5] + +a[6]); }
    else if (c === "INCR") { const v = (vivo(a[1]) ? +kv.str.get(a[1]) : 0) + 1; kv.str.set(a[1], String(v)); r = v; }
    else if (c === "EXPIRE") { kv.exp.set(a[1], Date.now() + +a[2] * 1000); r = 1; }
    else if (c === "HINCRBY") { if (!kv.h.has(a[1])) kv.h.set(a[1], new Map()); const m = kv.h.get(a[1]); m.set(a[2], (m.get(a[2]) || 0) + +a[3]); r = m.get(a[2]); }
    else if (c === "HGETALL") { const m = kv.h.get(a[1]) || new Map(); r = [...m].flatMap(([k, v]) => [k, String(v)]); }
    else if (c === "ZREVRANGE") { const z = kv.z.get(a[1]) || new Map(); r = [...z].sort((x, y) => y[1] - x[1]).slice(+a[2], +a[3] + 1).map((x) => x[0]); }
    else if (c === "MGET") r = a.slice(1).map((k) => (vivo(k) ? kv.str.get(k) : null));
    else if (c === "EVAL") {
      // O simulador executa os scripts conhecidos de forma atômica (um comando por vez no Node).
      const lua = a[1], n = +a[2], K = a.slice(3, 3 + n), A = a.slice(3 + n);
      if (lua === LUA_DESTRAVAR) { if (vivo(K[0]) && kv.str.get(K[0]) === A[0]) { kv.str.delete(K[0]); r = 1; } else r = 0; }
      else if (lua === LUA_REGISTRAR) { if (vivo(K[0])) r = 0; else { setk(K[0], A[0]); zadd(K[1], A[1], A[2]); r = 1; } }
      else if (lua === LUA_ATUALIZAR) {
        setk(K[0], A[0], A[1] || null);
        if (A[2] === "add") zadd(K[1], A[3], A[5]); else if (A[2] === "rem") zrem(K[1], A[5]);
        if (A[4] === "add") zadd(K[2], A[3], A[5]); else if (A[4] === "rem") zrem(K[2], A[5]);
        r = 1;
      } else return { erro: "script desconhecido" };
    } else return { erro: "comando nao suportado" };
    return { r };
}

// ---------------- Variáveis como na Vercel (valores FICTÍCIOS de teste) ----------------
Object.assign(process.env, { CRM_BASE_URL: `http://127.0.0.1:${PORT + 1}`, CRM_SOURCE_ID: SOURCE, CRM_CADASTRO_SECRET: SEGREDO, CRM_TIMEOUT_MS: "2000", CRON_SECRET: "cron-de-teste" });
if (process.env.SIM_SEM_SOURCE === "1") delete process.env.CRM_SOURCE_ID;
// Contas de TESTE da central (fictícias). As contas reais ficam só na variável CENTRAL_ACESSOS da Vercel.
const crypto2 = require("crypto");
const resumo = (s) => { const sal = crypto2.randomBytes(16).toString("hex"); return "scrypt$" + sal + "$" + crypto2.scryptSync(s, sal, 32).toString("hex"); };
Object.assign(process.env, {
  CENTRAL_GERAL_EMAIL: "dono@teste.invalid", CENTRAL_SENHA_GERAL: "senha-geral-teste",
  CENTRAL_ACESSOS: JSON.stringify({
    "itajai@teste.invalid": { acesso: "itajai", senha: resumo("Teste-Itajai-1") },
    "navegantes@teste.invalid": { acesso: "navegantes", senha: resumo("Teste-Navegantes-1") },
    "camboriu@teste.invalid": { acesso: "camboriu", senha: resumo("Teste-Camboriu-1") },
    "gerente": { acesso: "geral", senha: resumo("Teste-Gerente-1") },
  }),
});
// ---------------- Supabase simulado (opcional): API /rest/v1/rpc/<função> em cima de um Postgres local ----------------
// SIM_SUPA_PG=postgres://... e SIM_PG_MODULE=<caminho do módulo pg>. Executa as MESMAS funções de supabase/central.sql como role anon.
if (process.env.SIM_SUPA_PG) {
  const { Pool } = require(process.env.SIM_PG_MODULE || "pg");
  const pool = new Pool({ connectionString: process.env.SIM_SUPA_PG, max: 4 });
  const ARGS = { central_salvar_lead: ["p_segredo", "p_lead"], central_clique: ["p_segredo", "p_loja", "p_origem", "p_dedupe", "p_lead_id"], central_tentativas: ["p_segredo", "p_chave", "p_acao"], central_dados: ["p_segredo", "p_lojas", "p_dias"], central_status: ["p_segredo", "p_id", "p_lojas", "p_status", "p_por", "p_motivo", "p_produto", "p_valor"] };
  http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", async () => {
      const m = /^\/rest\/v1\/rpc\/(\w+)$/.exec(req.url);
      if (!m || !ARGS[m[1]] || req.headers.apikey !== "chave-publica-teste") { res.statusCode = 401; return res.end("{}"); }
      const body = JSON.parse(b || "{}"), nomes = ARGS[m[1]];
      const vals = nomes.map((n) => (n === "p_lead" ? JSON.stringify(body[n]) : body[n]));
      const cli = await pool.connect();
      try {
        await cli.query("begin"); await cli.query("set local role anon");
        const r = await cli.query(`select public.${m[1]}(${nomes.map((n, i) => n + " => $" + (i + 1)).join(", ")}) as r`, vals);
        await cli.query("commit");
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify(r.rows[0].r));
      } catch (e) { await cli.query("rollback").catch(() => {}); res.statusCode = 400; res.end(JSON.stringify({ message: String(e.message) })); }
      finally { cli.release(); }
    });
  }).listen(PORT + 3);
  Object.assign(process.env, { CENTRAL_SUPABASE_URL: `http://127.0.0.1:${PORT + 3}`, CENTRAL_SUPABASE_KEY: "chave-publica-teste", CENTRAL_DB_SEGREDO: process.env.SIM_SUPA_SEGREDO || "" });
}
if (USA_KV) Object.assign(process.env, { KV_REST_API_URL: `http://127.0.0.1:${PORT + 2}`, KV_REST_API_TOKEN: "token-kv-teste" });
const cad = require(path.join(ROOT, "api", "cadastro.js")), rep = require(path.join(ROOT, "api", "cadastro-reprocessar.js"));
const clique = require(path.join(ROOT, "api", "clique.js")), central = require(path.join(ROOT, "api", "central.js"));
const tipos = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mp4": "video/mp4", ".css": "text/css" };
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/cadastro") return cad(req, res);
  if (u.pathname === "/api/cadastro-reprocessar") return rep(req, res);
  if (u.pathname === "/api/clique") return clique(req, res);
  if (u.pathname === "/api/central") return central(req, res);
  let f = path.join(ROOT, decodeURIComponent(u.pathname)); if (u.pathname === "/") f = path.join(ROOT, "index.html");
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end("nf"); }
  res.setHeader("content-type", tipos[path.extname(f)] || "application/octet-stream");
  fs.createReadStream(f).on("error", () => {}).pipe(res).on("error", () => {});
}).listen(PORT, () => console.log("pronto"));
