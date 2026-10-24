// Central de leads da LP: guarda cada lead do formulário e conta os cliques nos botões de WhatsApp,
// separados por loja. Onde guarda (o primeiro que estiver configurado na Vercel):
//   Supabase  CENTRAL_SUPABASE_URL + CENTRAL_SUPABASE_KEY + CENTRAL_DB_SEGREDO  (funções em supabase/central.sql)
//   KV        KV_REST_API_URL + KV_REST_API_TOKEN (Vercel KV / Upstash, ver _store.js)
//
// Acesso: cada loja entra com o próprio e-mail e senha (variável CENTRAL_ACESSOS da Vercel, só com o resumo scrypt da senha)
// e só recebe os dados da própria loja.
// Opcional na Vercel:
//   CENTRAL_SENHA_ITAJAI / _NAVEGANTES / _CAMBORIU  substitui a senha da loja (mín. 8 caracteres)
//   CENTRAL_GERAL_EMAIL + CENTRAL_SENHA_GERAL         acesso extra de gerente (o usuário "gerente" já existe em _acessos.js)

const crypto = require("crypto");
const LOJAS = require("./_lojas");
const porEmail = require("./_acessos");
const { getStore } = require("./_store");

const P = "edc:central:";
const ORIGENS = ["site", "pre-analise"];
const ACESSOS = { itajai: "CENTRAL_SENHA_ITAJAI", navegantes: "CENTRAL_SENHA_NAVEGANTES", camboriu: "CENTRAL_SENHA_CAMBORIU", geral: "CENTRAL_SENHA_GERAL" };
const SESSAO_MS = 12 * 3600 * 1000;
const MAX_LEADS = 2000;
const DIAS_GRAFICO = 30;

function diaSP(ms) {
  // AAAA-MM-DD no fuso de São Paulo
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
function hash(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 32);
}
function ipDe(req) {
  return String((req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"])) || (req.socket && req.socket.remoteAddress) || "")
    .split(",")[0]
    .trim();
}

// ---------------- Onde os dados ficam ----------------

// Supabase: chama as funções RPC protegidas pelo segredo do servidor.
function baseSupabase(env) {
  const url = String(env.CENTRAL_SUPABASE_URL || "").replace(/\/+$/, "");
  const chave = env.CENTRAL_SUPABASE_KEY;
  const segredo = env.CENTRAL_DB_SEGREDO;
  if (!url || !chave || !segredo) return null;
  async function rpc(fn, args) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(url + "/rest/v1/rpc/" + fn, {
        method: "POST",
        headers: { apikey: chave, Authorization: "Bearer " + chave, "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ p_segredo: segredo }, args)),
        signal: ctrl.signal,
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error("supabase_" + r.status);
      return j;
    } finally {
      clearTimeout(t);
    }
  }
  return {
    tipo: "supabase",
    salvarLead: (lead) => rpc("central_salvar_lead", { p_lead: lead }),
    clique: (loja, origem, dedupe, leadId) => rpc("central_clique", { p_loja: loja, p_origem: origem, p_dedupe: dedupe, p_lead_id: leadId || "" }),
    tentativas: (chave, acao) => rpc("central_tentativas", { p_chave: chave, p_acao: acao }).then(Number),
    dados: (lojas, dias) => rpc("central_dados", { p_lojas: lojas, p_dias: dias }),
  };
}

// KV (Upstash / Vercel KV): mesmas operações sobre chaves.
function baseKV(store) {
  return {
    tipo: "kv",
    async salvarLead(lead) {
      const novo = await store.setNovo(P + "lead:" + lead.id, lead);
      if (novo) await store.pipeline([["ZADD", P + "leads:" + lead.loja, Date.parse(lead.criado_em) || Date.now(), lead.id]]);
      return novo;
    },
    async clique(loja, origem, dedupe, leadId) {
      if (!(await store.setNovo(P + "dedupe:" + dedupe, 1, 3))) return "repetido";
      const kd = P + "cliques:" + loja + ":" + diaSP(Date.now());
      await store.pipeline([["HINCRBY", P + "cliques:" + loja, origem, 1], ["HINCRBY", kd, origem, 1], ["EXPIRE", kd, 400 * 86400]]);
      if (leadId) {
        const lead = await store.get(P + "lead:" + leadId);
        if (lead && lead.loja === loja && !lead.clicou_whatsapp_em) {
          lead.clicou_whatsapp_em = new Date().toISOString();
          await store.set(P + "lead:" + leadId, lead);
        }
      }
      return "ok";
    },
    async tentativas(chave, acao) {
      const k = P + "tentativas:" + chave;
      if (acao === "ver") return Number((await store.pipeline([["GET", k]]))[0] || 0);
      if (acao === "erro") return Number((await store.pipeline([["INCR", k], ["EXPIRE", k, 900]]))[0] || 0);
      await store.pipeline([["DEL", k]]);
      return 0;
    },
    async dados(lojas, ndias) {
      const agora = Date.now();
      const dias = [];
      for (let i = ndias - 1; i >= 0; i--) dias.push(diaSP(agora - i * 86400000));
      const cmds = [];
      for (const l of lojas) {
        cmds.push(["HGETALL", P + "cliques:" + l]);
        for (const d of dias) cmds.push(["HGETALL", P + "cliques:" + l + ":" + d]);
        cmds.push(["ZREVRANGE", P + "leads:" + l, 0, MAX_LEADS - 1]);
      }
      const r = await store.pipeline(cmds);
      const out = { leads: [], totais: [], dias: [] };
      let ids = [];
      let i = 0;
      for (const l of lojas) {
        const tot = hashParaObj(r[i++]);
        for (const o of ORIGENS) if (tot[o]) out.totais.push({ loja: l, origem: o, total: tot[o] });
        for (const d of dias) {
          const h = hashParaObj(r[i++]);
          for (const o of ORIGENS) if (h[o]) out.dias.push({ loja: l, dia: d, origem: o, total: h[o] });
        }
        ids = ids.concat(r[i++] || []);
      }
      for (let k = 0; k < ids.length; k += 200) {
        const v = (await store.pipeline([["MGET", ...ids.slice(k, k + 200).map((x) => P + "lead:" + x)]]))[0] || [];
        for (const s of v) if (s) { try { out.leads.push(JSON.parse(s)); } catch (e) {} }
      }
      return out;
    },
  };
}

function base(env) {
  env = env || process.env;
  const s = baseSupabase(env);
  if (s) return s;
  const store = getStore(env);
  return store ? baseKV(store) : null;
}

// ---------------- Gravação ----------------

// Guarda o lead uma única vez por external_id (reenvios do mesmo formulário não duplicam).
async function salvarLead(env, c, agora) {
  const b = base(env);
  if (!b) return null;
  agora = agora || Date.now();
  const lead = {
    id: c.external_id,
    loja: c.loja,
    cidade: c.cidade || (LOJAS[c.loja] && LOJAS[c.loja].nome) || c.loja,
    nome: c.nome,
    telefone: c.telefone,
    cpf: c.cpf || "",
    criado_em: new Date(agora).toISOString(),
  };
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) if (c[k]) lead[k] = c[k];
  return await b.salvarLead(lead);
}

// Conta um clique no botão de WhatsApp de uma loja. Cliques repetidos do mesmo aparelho em 3 s contam uma vez.
async function registrarClique(env, { loja, origem, id, ip }) {
  const b = base(env);
  if (!b) return { ok: false, erro: "armazenamento_nao_configurado" };
  if (!LOJAS[loja] || !ORIGENS.includes(origem)) return { ok: false, erro: "invalido" };
  const leadId = id && /^pag-agendamento:[a-z0-9-]+:[0-9a-f-]{36}$/.test(id) ? id : "";
  const r = await b.clique(loja, origem, hash(ip + "|" + loja + "|" + origem), leadId);
  return { ok: true, repetido: r === "repetido" };
}

// ---------------- Acesso ----------------

function senhaDe(env, acesso) {
  const v = env[ACESSOS[acesso]];
  return v && String(v).length >= 8 ? String(v) : null;
}
function normEmail(e) {
  return String(e || "").trim().toLowerCase();
}
function acessoPorEmail(env, email) {
  const e = normEmail(email);
  if (!e) return null;
  if (env.CENTRAL_GERAL_EMAIL && e === normEmail(env.CENTRAL_GERAL_EMAIL)) return "geral";
  const x = porEmail()[e];
  return x && ACESSOS[x.acesso] ? x.acesso : null;
}
function acessoAtivo(env, acesso) {
  if (acesso === "geral" && senhaDe(env, "geral") && env.CENTRAL_GERAL_EMAIL) return true;
  return !!((acesso !== "geral" && senhaDe(env, acesso)) || Object.values(porEmail()).some((x) => x.acesso === acesso));
}
function scryptConfere(senha, guardado) {
  const p = String(guardado || "").split("$");
  if (p.length !== 3 || p[0] !== "scrypt") return false;
  const h = crypto.scryptSync(String(senha), p[1], 32);
  const g = Buffer.from(p[2], "hex");
  return g.length === h.length && crypto.timingSafeEqual(g, h);
}
const RESUMO_FALSO = "scrypt$00000000000000000000000000000000$" + "0".repeat(64);
function senhaConfere(env, acesso, email, senha) {
  const e = normEmail(email);
  // Gerente: o e-mail opcional da Vercel usa a senha da Vercel; o usuário "gerente" usa a senha do código
  if (acesso === "geral" && env.CENTRAL_GERAL_EMAIL && e === normEmail(env.CENTRAL_GERAL_EMAIL)) {
    const v = senhaDe(env, "geral");
    return !!v && iguais(senha, v);
  }
  const daVercel = acesso !== "geral" ? senhaDe(env, acesso) : null;
  if (daVercel) return iguais(senha, daVercel);
  const x = porEmail()[e];
  return !!x && x.acesso === acesso && scryptConfere(senha, x.senha);
}
function chaveSessao(env) {
  if (env.CENTRAL_SESSAO_SEGREDO && env.CENTRAL_SESSAO_SEGREDO.length >= 16) return env.CENTRAL_SESSAO_SEGREDO;
  // Derivada do token secreto do armazenamento + senhas: trocar qualquer senha derruba as sessões abertas.
  return hash(
    "edc-central-sessao|" +
      Object.keys(ACESSOS).map((a) => senhaDe(env, a) || "").join("|") +
      "|" + Object.values(porEmail()).map((x) => x.senha).join("|") +
      "|" + (env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || "")
  );
}
function iguais(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function assinar(env, acesso, agora) {
  const corpo = Buffer.from(JSON.stringify({ a: acesso, e: (agora || Date.now()) + SESSAO_MS })).toString("base64url");
  const sig = crypto.createHmac("sha256", chaveSessao(env)).update(corpo).digest("base64url");
  return corpo + "." + sig;
}
function verificar(env, token, agora) {
  if (!token || typeof token !== "string" || token.indexOf(".") < 0) return null;
  const [corpo, sig] = token.split(".");
  const esperado = crypto.createHmac("sha256", chaveSessao(env)).update(corpo).digest("base64url");
  if (!sig || sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  let d;
  try { d = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8")); } catch (e) { return null; }
  if (!d || !ACESSOS[d.a] || !(d.e > (agora || Date.now()))) return null;
  if (!acessoAtivo(env, d.a)) return null; // acesso desativado depois do login
  return d.a;
}

// Login por e-mail e senha, com limite de tentativas por endereço (10 erros em 15 min bloqueiam).
async function entrar(env, { email, senha, ip }) {
  const b = base(env);
  if (!b) return { ok: false, status: 503, erro: "armazenamento_nao_configurado" };
  const kt = hash(ip || "?");
  if ((await b.tentativas(kt, "ver")) >= 10) return { ok: false, status: 429, erro: "muitas_tentativas" };
  const acesso = acessoPorEmail(env, email);
  let certo = false;
  if (acesso && acessoAtivo(env, acesso)) certo = senhaConfere(env, acesso, email, senha || "");
  else scryptConfere(senha || "", RESUMO_FALSO); // mesmo tempo de resposta para e-mail desconhecido
  if (!certo) {
    await b.tentativas(kt, "erro");
    return { ok: false, status: 401, erro: "acesso_incorreto" };
  }
  await b.tentativas(kt, "limpar");
  return { ok: true, token: assinar(env, acesso), acesso };
}

// ---------------- Leitura ----------------

function lojasDoAcesso(acesso) {
  return acesso === "geral" ? Object.keys(LOJAS) : [acesso];
}

async function dados(env, acesso, agora) {
  const b = base(env);
  if (!b) throw new Error("armazenamento_nao_configurado");
  agora = agora || Date.now();
  const lojas = lojasDoAcesso(acesso);
  const dias = [];
  for (let i = DIAS_GRAFICO - 1; i >= 0; i--) dias.push(diaSP(agora - i * 86400000));
  const r = await b.dados(lojas, DIAS_GRAFICO);
  const cliques = {};
  for (const l of lojas) {
    const tot = { site: 0, "pre-analise": 0 };
    for (const t of r.totais || []) if (t.loja === l && tot[t.origem] != null) tot[t.origem] += Number(t.total) || 0;
    const porDia = dias.map((d) => {
      const x = { dia: d, site: 0, "pre-analise": 0 };
      for (const t of r.dias || []) if (t.loja === l && t.dia === d && x[t.origem] != null) x[t.origem] += Number(t.total) || 0;
      return x;
    });
    cliques[l] = { site: tot.site, "pre-analise": tot["pre-analise"], dias: porDia };
  }
  // Defesa extra: nunca devolve lead de outra loja
  const leads = (r.leads || [])
    .filter((x) => x && lojas.includes(x.loja))
    .sort((a, b) => (a.criado_em < b.criado_em ? 1 : -1))
    .slice(0, MAX_LEADS);
  return { acesso, lojas: lojas.map((l) => ({ codigo: l, nome: LOJAS[l].nome })), hoje: diaSP(agora), cliques, leads };
}

function hashParaObj(v) {
  const o = {};
  if (Array.isArray(v)) for (let j = 0; j < v.length; j += 2) o[v[j]] = Number(v[j + 1]) || 0;
  else if (v && typeof v === "object") for (const k of Object.keys(v)) o[k] = Number(v[k]) || 0;
  return o;
}

module.exports = { salvarLead, registrarClique, entrar, verificar, dados, ipDe, base, ACESSOS, ORIGENS, diaSP };
