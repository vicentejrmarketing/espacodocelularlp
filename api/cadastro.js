// Recebe o cadastro da página de pré-análise, registra de forma durável (se houver armazenamento
// configurado) e repassa ao receptor de cadastros do CRM.
// URLs e segredos ficam só em variáveis de ambiente da Vercel. Veja .env.example.
//
// Respostas para a página:
//   200 {ok:true, status:"concluido"}            CRM confirmou (2xx)
//   202 {ok:true, status:"pendente"|...}          registrado no servidor; o servidor reenvia sozinho
//   502 {ok:false, retry:true}                    sem armazenamento e o CRM falhou: a página reenvia
//   422 {ok:false, retry:false}                   dados inválidos (inclui loja ausente/inválida)

const LOJAS = require("./_lojas");

const ORIGEM_ENTRADA = "LP + Agendamento";
const TAG_ORIGEM = "PAG+AGENDAMENTO";
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
const ID_RE = /^pag-agendamento:([a-z0-9-]+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const ISO_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?([+-]\d{2}:\d{2}|Z)$/;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function texto(v, max) {
  if (v == null) return "";
  return String(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function normalizarTelefone(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  if (d[0] === "0") return null;
  return "+55" + d;
}

function cpfValido(c) {
  c = String(c || "").replace(/\D/g, "");
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  for (let t = 9; t < 11; t++) {
    let s = 0;
    for (let i = 0; i < t; i++) s += +c[i] * (t + 1 - i);
    if (((s * 10) % 11) % 10 !== +c[t]) return false;
  }
  return true;
}

async function lerCorpo(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > 20000) throw new Error("payload_grande");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

// Valida e monta o cadastro. Campos de origem são definidos aqui, não pelo navegador.
function montarCadastro(b) {
  const erros = [];
  const external_id = texto(b.external_id, 200);
  const m = ID_RE.exec(external_id);
  const loja = texto(b.loja, 40).toLowerCase();
  if (!LOJAS[loja]) erros.push("loja");
  if (!m) erros.push("external_id");
  else if (m[1] !== loja) erros.push("external_id_loja");
  const nome = texto(b.nome, 200);
  if (nome.length < 2) erros.push("nome");
  const telefone = normalizarTelefone(b.telefone);
  if (!telefone) erros.push("telefone");
  const submitted_at = texto(b.submitted_at, 40);
  if (!ISO_TZ_RE.test(submitted_at) || isNaN(Date.parse(submitted_at))) erros.push("submitted_at");
  const cpfDig = String(b.cpf || "").replace(/\D/g, "");
  if (cpfDig && !cpfValido(cpfDig)) erros.push("cpf");

  const c = {
    external_id,
    nome,
    telefone,
    loja,
    origem_entrada: ORIGEM_ENTRADA,
    tag_origem: TAG_ORIGEM,
    submitted_at,
  };
  for (const k of UTM_KEYS) {
    const v = texto(b[k], 500);
    if (v) c[k] = v; // UTM vazia não é enviada
  }
  // consentimento_contato: o formulário atual não coleta consentimento, então o campo NÃO é enviado
  // (ausência nunca vira true).
  if (cpfDig) c.cpf = cpfDig;
  if (LOJAS[loja]) c.cidade = LOJAS[loja].nome;
  return { erros, cadastro: c };
}

const { enviarAoCRM } = require("./_crm");
const { getStore } = require("./_store");
const { registrar, processar, reprocessarVencidos } = require("./_processar");
const { salvarLead } = require("./_central");

async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { ok: false, erro: "metodo" });
  }
  let b;
  try {
    b = await lerCorpo(req);
  } catch (e) {
    return json(res, 400, { ok: false, erro: "corpo_invalido", retry: false });
  }
  const { erros, cadastro } = montarCadastro(b || {});
  if (erros.length) {
    // Loja ausente/inválida: não escolhe loja padrão e não envia ao CRM.
    return json(res, 422, { ok: false, erro: "validacao", campos: erros, retry: false });
  }
  const env = process.env;
  const id = cadastro.external_id;
  const obrigatoria = env.PERSISTENCIA_OBRIGATORIA === "1";

  // Modo durável: grava antes de chamar o CRM; o servidor reenvia mesmo se a aba for fechada.
  //   ok:true  = o servidor assumiu a responsabilidade (registro durável). NÃO significa card criado.
  //   entregue = o CRM confirmou o recebimento conforme o contrato.
  const store = getStore(env);
  // Central de leads da loja: guarda o lead (uma vez por external_id), independente do CRM.
  const salvo = await salvarLead(env, cadastro).catch(() => {
    console.error(JSON.stringify({ evento: "central_leads", external_id: id, estado: "falha_ao_salvar", nivel: "alerta" }));
    return false;
  });
  if (salvo === null) console.error(JSON.stringify({ evento: "central_leads", external_id: id, estado: "armazenamento_nao_configurado", nivel: "alerta" }));
  if (store) {
    try {
      const reg = await registrar(store, cadastro);
      if (reg && reg.conflito) {
        return json(res, 409, { ok: false, erro: "conflito_external_id", retry: false, external_id: id });
      }
      let rec = reg;
      if (reg && reg.status !== "concluido" && reg.status !== "falha_permanente") {
        rec = await processar(store, id, env);
      }
      // Aproveita a chamada para reenviar outros pendentes vencidos.
      await reprocessarVencidos(store, env, { limite: 3, orcamentoMs: 2500, ignorar: id }).catch(() => {});
      res.setHeader("X-Persistencia", "duravel");
      const status = rec && rec.emProcessamento ? "em_processamento" : (rec && rec.status) || "pendente";
      const entregue = status === "concluido";
      return json(res, entregue ? 200 : 202, { ok: true, persistido: true, entregue, status, external_id: id });
    } catch (e) {
      console.error(JSON.stringify({ evento: "cadastro", external_id: id, estado: "armazenamento_indisponivel", nivel: "alerta" }));
      // segue para o envio direto abaixo, sem prometer persistência
    }
  } else if (obrigatoria) {
    console.error(JSON.stringify({ evento: "cadastro", external_id: id, estado: "armazenamento_nao_configurado", nivel: "alerta" }));
  }

  // Sem persistência (não configurada ou indisponível): tenta entregar direto; se falhar, o navegador reenvia.
  res.setHeader("X-Persistencia", "indisponivel");
  const r = await enviarAoCRM(cadastro, env);
  console.log(JSON.stringify({ evento: "cadastro", external_id: id, estado: r.classe, motivo: r.motivo, http: r.status }));
  if (r.classe === "ok") return json(res, 200, { ok: true, persistido: false, entregue: true, status: "concluido", external_id: id });
  const retry = r.classe === "transitoria" || r.classe === "nao_confirmado";
  const erro = obrigatoria ? "persistencia_indisponivel" : r.motivo || r.classe;
  return json(res, retry ? 503 : 502, { ok: false, persistido: false, entregue: false, erro, retry, external_id: id });
}

module.exports = handler;
module.exports.montarCadastro = montarCadastro;
module.exports.normalizarTelefone = normalizarTelefone;
