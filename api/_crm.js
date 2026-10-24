// Envio do cadastro ao receptor PAG+AGENDAMENTO do CRM, conforme o contrato informado pela equipe CRM:
//
//   POST {CRM_BASE_URL}/api/v1/webhooks/pag-agendamento/{CRM_SOURCE_ID}/cadastro
//   Corpo: application/x-www-form-urlencoded (padrão) ou JSON, máximo 64 KiB, sem chaves repetidas
//   Assinatura: X-Pag-Agendamento-Signature = HMAC-SHA256 dos bytes exatos do corpo, hexadecimal, SEM prefixo
//   Confirmação (obrigatória): 2xx + JSON + data.external_id idêntico + data.persisted === true (booleano)
//
// Variáveis de ambiente (valores fornecidos pela equipe CRM; nunca no Git):
//   CRM_BASE_URL            ex.: https://<host-fornecido>   (sem barra final; não deduzir do domínio)
//   CRM_SOURCE_ID           UUID da fonte fornecido pela equipe CRM
//   CRM_CADASTRO_SECRET     segredo do HMAC do cadastro (diferente do segredo do Cal.com)
//   CRM_CADASTRO_FORMAT     "form" (padrão) ou "json"
//   CRM_TIMEOUT_MS          tempo limite da chamada (padrão 8000)

const crypto = require("crypto");

const CABECALHO_ASSINATURA = "X-Pag-Agendamento-Signature";
const LIMITE_CORPO = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function timeoutMs(env) {
  return Number(env.CRM_TIMEOUT_MS) || 8000;
}

// Monta a URL a partir da base e do sourceId fornecidos. Retorna null se a configuração estiver incompleta/inválida.
function urlCadastro(env) {
  const base = String(env.CRM_BASE_URL || "").replace(/\/+$/, "");
  const fonte = String(env.CRM_SOURCE_ID || "");
  if (!/^https?:\/\/[^/\s]+/i.test(base) || !UUID_RE.test(fonte)) return null;
  return `${base}/api/v1/webhooks/pag-agendamento/${fonte}/cadastro`;
}

function montarRequisicao(cadastro, env) {
  if (!env.CRM_CADASTRO_SECRET) return { erroConfig: "segredo_ausente" };
  const formato = (env.CRM_CADASTRO_FORMAT || "form").toLowerCase();
  let body, contentType;
  if (formato === "json") {
    contentType = "application/json";
    body = JSON.stringify(cadastro);
  } else {
    contentType = "application/x-www-form-urlencoded";
    body = new URLSearchParams(cadastro).toString(); // "+" vira %2B; cada chave aparece uma vez
  }
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length > LIMITE_CORPO) return { erroConfig: "corpo_acima_de_64kib" };
  const assinatura = crypto.createHmac("sha256", env.CRM_CADASTRO_SECRET).update(bytes).digest("hex");
  return {
    bytes,
    headers: {
      "Content-Type": contentType,
      "Idempotency-Key": cadastro.external_id,
      [CABECALHO_ASSINATURA]: assinatura,
    },
  };
}

// Classes: ok | nao_confirmado | transitoria | conflito | permanente_contrato | permanente_auth | permanente_fonte | permanente_config
function classificar(status) {
  if (status >= 200 && status < 300) return "ok";
  if (status === 0 || status === 408 || status === 425 || status === 429 || status === 502 || status === 503 || status === 504 || status >= 500) return "transitoria";
  if (status === 409) return "conflito";
  if (status === 400 || status === 413 || status === 415 || status === 422) return "permanente_contrato";
  if (status === 401 || status === 403) return "permanente_auth";
  if (status === 404) return "permanente_fonte"; // fonte indisponível ou desligada
  return "permanente_config";
}

// Confirmação durável conforme contrato: só conta como entregue com data.external_id idêntico e data.persisted === true.
function confirmar(texto, contentType, cadastro) {
  if (!/^application\/(.+\+)?json\b/i.test(String(contentType || "").trim())) return { ok: false, motivo: "resposta_nao_json" };
  let j;
  try {
    j = JSON.parse(texto);
  } catch (e) {
    return { ok: false, motivo: "json_invalido" };
  }
  const d = j && typeof j === "object" ? j.data : null;
  if (!d || typeof d !== "object") return { ok: false, motivo: "sem_data" };
  if (d.external_id !== cadastro.external_id) return { ok: false, motivo: "id_divergente" };
  if (d.persisted !== true) return { ok: false, motivo: "persisted_nao_true" };
  return {
    ok: true,
    // Comprovante mínimo (sem dados pessoais) guardado pela LP para auditoria e deduplicação.
    comprovante: {
      receipt_id: typeof d.receipt_id === "string" ? d.receipt_id.slice(0, 100) : null,
      submission_id: typeof d.submission_id === "string" ? d.submission_id.slice(0, 100) : null,
      lead_id: d.lead_id == null ? null : String(d.lead_id).slice(0, 100),
      status: typeof d.status === "string" ? d.status.slice(0, 50) : null, // applied | pending_* | ignored_*
    },
  };
}

async function enviarAoCRM(cadastro, env) {
  const url = urlCadastro(env);
  if (!url) return { classe: "transitoria", status: 0, motivo: "config_pendente" };
  const req = montarRequisicao(cadastro, env);
  if (req.erroConfig) return { classe: req.erroConfig === "segredo_ausente" ? "transitoria" : "permanente_contrato", status: 0, motivo: req.erroConfig };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs(env));
  try {
    const r = await fetch(url, { method: "POST", headers: req.headers, body: req.bytes, signal: ctrl.signal, redirect: "manual" });
    const texto = (await r.text().catch(() => "")).slice(0, 65536);
    let classe = classificar(r.status);
    let motivo, comprovante;
    if (classe === "ok") {
      const c = confirmar(texto, r.headers.get("content-type"), cadastro);
      if (c.ok) comprovante = c.comprovante;
      else {
        // 2xx sem confirmação durável válida NÃO é entrega. Reenvia com o mesmo id.
        classe = "nao_confirmado";
        motivo = c.motivo;
      }
    }
    return { classe, status: r.status, motivo, comprovante };
  } catch (e) {
    return { classe: "transitoria", status: 0, motivo: e && e.name === "AbortError" ? "timeout" : "rede" };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { enviarAoCRM, classificar, montarRequisicao, confirmar, urlCadastro, timeoutMs, CABECALHO_ASSINATURA };
