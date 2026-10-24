// Guarda durável de cada submissão e reenvio independente do navegador.
//
// Chaves (prefixo com hash tag {pagag} para ficarem no mesmo slot do Redis):
//   {pagag}:cad:<external_id>   registro único da submissão (JSON)
//   {pagag}:pendentes           conjunto ordenado: próximo envio de cada pendente
//   {pagag}:falhas              conjunto ordenado: falhas permanentes aguardando a operação
//   {pagag}:lock:<id>           trava com dono do envio de um cadastro
//   {pagag}:lock:agendador      trava com dono da execução periódica (evita sobreposição)
//   {pagag}:agendador:ultima    última execução do agendador (para monitoramento)
//
// Estados do registro:
//   pendente            sob guarda da LP; ainda sem confirmação durável do CRM
//   falha_transitoria   rede, timeout, 429/5xx ou 2xx SEM confirmação válida: reenvio com backoff
//   falha_permanente    400/401/404/409/413, configuração inválida ou tentativas esgotadas: pendência visível
//   concluido           CRM confirmou guarda durável (data.persisted === true). NÃO significa card aplicado.
//   descartado          removido por decisão explícita da operação (payload apagado)
//
// Gravação: registro + fila são gravados juntos por script atômico (EVAL). Nenhuma escrita parcial.
// Retenção: não entregues não expiram sozinhos; concluído sem dados pessoais expira em 180 dias.

const crypto = require("crypto");
const { enviarAoCRM, timeoutMs } = require("./_crm");

const P = "{pagag}";
const FILA = P + ":pendentes";
const FALHAS = P + ":falhas";
const ULTIMA = P + ":agendador:ultima";
const TRAVA_AGENDADOR = P + ":lock:agendador";
const TTL_CONCLUIDO = 180 * 24 * 3600;
const ESPERAS_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480, 720, 1440];
const MAX_TENTATIVAS = 15;
const chave = (id) => P + ":cad:" + id;
const trava = (id) => P + ":lock:" + id;

// Cria o registro e o coloca na fila numa única operação atômica. Retorna 1 se criou, 0 se já existia.
const LUA_REGISTRAR =
  "if redis.call('SET', KEYS[1], ARGV[1], 'NX') then redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3]) return 1 end return 0";

// Atualiza registro + fila de pendentes + fila de falhas numa única operação atômica.
// ARGV: 1 json | 2 ttl ('' = sem expiração) | 3 op pendentes ('add'|'rem'|'') | 4 pontuação | 5 op falhas | 6 id
const LUA_ATUALIZAR =
  "if ARGV[2] ~= '' then redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]) else redis.call('SET', KEYS[1], ARGV[1]) end " +
  "if ARGV[3] == 'add' then redis.call('ZADD', KEYS[2], ARGV[4], ARGV[6]) elseif ARGV[3] == 'rem' then redis.call('ZREM', KEYS[2], ARGV[6]) end " +
  "if ARGV[5] == 'add' then redis.call('ZADD', KEYS[3], ARGV[4], ARGV[6]) elseif ARGV[5] == 'rem' then redis.call('ZREM', KEYS[3], ARGV[6]) end " +
  "return 1";

function log(dados) {
  // Sem dados pessoais e sem segredos.
  console.log(JSON.stringify(Object.assign({ evento: "cadastro" }, dados)));
}

function hashCadastro(c) {
  return crypto.createHash("sha256").update(JSON.stringify([c.nome, c.telefone, c.loja, c.cpf || ""])).digest("hex");
}

async function atualizar(store, id, rec, { ttl = "", fila = "", falhas = "", pontuacao = Date.now() } = {}) {
  await store.script(LUA_ATUALIZAR, [chave(id), FILA, FALHAS], [JSON.stringify(rec), ttl, fila, pontuacao, falhas, id]);
}

// Guarda a submissão ANTES de chamar o CRM.
async function registrar(store, cadastro) {
  const id = cadastro.external_id;
  const hash = hashCadastro(cadastro);
  const agora = Date.now();
  const rec = { status: "pendente", tentativas: 0, proximo_envio: agora, criado: agora, atualizado: agora, hash, payload: cadastro };
  const criou = await store.script(LUA_REGISTRAR, [chave(id), FILA], [JSON.stringify(rec), agora, id]);
  if (Number(criou) === 1) {
    log({ external_id: id, estado: "registrado" });
    return rec;
  }
  const atual = await store.get(chave(id));
  if (atual && atual.hash && atual.hash !== hash) {
    // Mesmo external_id com conteúdo diferente: conflito explícito, original preservado, sem reenvio.
    log({ external_id: id, estado: "conflito_external_id", nivel: "alerta" });
    return { conflito: true };
  }
  return atual;
}

// Envia um cadastro registrado. Retorna o registro, {emProcessamento:true} ou {inexistente:true}.
async function processar(store, id, env) {
  const validade = Math.ceil(timeoutMs(env) / 1000) * 2 + 15; // sempre maior que a chamada ao CRM
  const dono = await store.travar(trava(id), validade);
  if (!dono) return { emProcessamento: true };
  try {
    const rec = await store.get(chave(id));
    if (!rec) {
      // Com a criação atômica, isto só ocorre se o registro foi removido manualmente.
      await store.desagendar(FILA, id);
      log({ external_id: id, estado: "fila_sem_registro", nivel: "alerta" });
      return { inexistente: true };
    }
    if (rec.status !== "pendente" && rec.status !== "falha_transitoria") {
      await store.desagendar(FILA, id);
      return rec;
    }
    const r = await enviarAoCRM(rec.payload, env);
    rec.tentativas = (rec.tentativas || 0) + 1;
    rec.ultimo_http = r.status;
    rec.ultimo_motivo = r.motivo || r.classe;
    rec.atualizado = Date.now();

    if (r.classe === "ok") {
      // Transferência de guarda confirmada: apaga o payload e guarda só o comprovante mínimo.
      rec.status = "concluido";
      rec.payload = null;
      rec.comprovante = r.comprovante;
      await atualizar(store, id, rec, { ttl: TTL_CONCLUIDO, fila: "rem", falhas: "rem" });
    } else if ((r.classe === "transitoria" || r.classe === "nao_confirmado") && rec.tentativas < MAX_TENTATIVAS) {
      rec.status = "falha_transitoria";
      const espera = ESPERAS_MIN[Math.min(rec.tentativas - 1, ESPERAS_MIN.length - 1)];
      rec.proximo_envio = Date.now() + espera * 60000;
      await atualizar(store, id, rec, { fila: "add", pontuacao: rec.proximo_envio });
    } else {
      // Não descarta: vira pendência visível, com o payload preservado para reativação controlada.
      rec.status = "falha_permanente";
      if (r.classe === "transitoria" || r.classe === "nao_confirmado") rec.ultimo_motivo = "tentativas_esgotadas:" + (r.motivo || r.classe);
      rec.falhou_em = Date.now();
      await atualizar(store, id, rec, { fila: "rem", falhas: "add", pontuacao: rec.falhou_em });
    }
    log({
      external_id: id,
      estado: rec.status,
      motivo: rec.ultimo_motivo,
      http: r.status,
      tentativa: rec.tentativas,
      crm_status: rec.comprovante ? rec.comprovante.status : undefined,
      receipt_id: rec.comprovante ? rec.comprovante.receipt_id : undefined,
      nivel: rec.status === "falha_permanente" ? "alerta" : undefined,
    });
    return rec;
  } finally {
    await store.destravar(trava(id), dono).catch(() => {});
  }
}

// Reenvia os pendentes cujo próximo envio já venceu (respeita o backoff de cada registro).
async function reprocessarVencidos(store, env, { limite = 10, orcamentoMs = 5000, ignorar } = {}) {
  const inicio = Date.now();
  const ids = await store.vencidos(FILA, Date.now(), limite);
  const feitos = [];
  for (const id of ids) {
    if (id === ignorar) continue;
    if (Date.now() - inicio > orcamentoMs) break;
    const rec = await processar(store, id, env);
    feitos.push({ external_id: id, status: rec.status || (rec.emProcessamento ? "em_processamento" : "inexistente") });
  }
  return feitos;
}

// Execução periódica com trava global (sem sobreposição) e registro da última execução.
async function executarAgendador(store, env, { limite = 25, orcamentoMs = 20000 } = {}) {
  const dono = await store.travar(TRAVA_AGENDADOR, Math.ceil(orcamentoMs / 1000) + Math.ceil(timeoutMs(env) / 1000) * 2 + 15);
  if (!dono) return { sobreposicao: true };
  const inicio = Date.now();
  try {
    const feitos = await reprocessarVencidos(store, env, { limite, orcamentoMs });
    await store.set(ULTIMA, { inicio, fim: Date.now(), processados: feitos.length, concluidos: feitos.filter((f) => f.status === "concluido").length });
    return { feitos };
  } finally {
    await store.destravar(TRAVA_AGENDADOR, dono).catch(() => {});
  }
}

// Depois da correção da causa, devolve falhas permanentes à fila (mesmo external_id e Idempotency-Key).
async function reativarFalhas(store, ids) {
  const alvo = ids && ids.length ? ids : await store.listar(FALHAS, 500);
  const reativados = [];
  for (const id of alvo) {
    const rec = await store.get(chave(id));
    if (!rec || rec.status !== "falha_permanente") continue;
    rec.status = "pendente";
    rec.tentativas = 0;
    rec.reativado_em = Date.now();
    rec.proximo_envio = Date.now();
    await atualizar(store, id, rec, { fila: "add", falhas: "rem", pontuacao: rec.proximo_envio });
    log({ external_id: id, estado: "reativado" });
    reativados.push(id);
  }
  return reativados;
}

// Descarte explícito (decisão da operação, ex.: dados de teste ou fim do prazo de retenção).
async function descartar(store, id) {
  const rec = await store.get(chave(id));
  if (!rec || rec.status === "concluido") return false;
  const lapide = { status: "descartado", descartado_em: Date.now(), ultimo_motivo: rec.ultimo_motivo, criado: rec.criado, hash: rec.hash, payload: null };
  await atualizar(store, id, lapide, { ttl: TTL_CONCLUIDO, fila: "rem", falhas: "rem" });
  log({ external_id: id, estado: "descartado", nivel: "alerta" });
  return true;
}

// Resumo operacional sem dados pessoais.
async function resumo(store) {
  const agora = Date.now();
  const detalhar = async (fila) => {
    const out = [];
    for (const [id] of await store.listarComPontuacao(fila, 200)) {
      const r = await store.get(chave(id));
      if (r) out.push({ external_id: id, status: r.status, motivo: r.ultimo_motivo, http: r.ultimo_http, tentativas: r.tentativas, idade_min: Math.round((agora - r.criado) / 60000) });
    }
    return out;
  };
  const p = await detalhar(FILA);
  const f = await detalhar(FALHAS);
  const ultima = await store.get(ULTIMA);
  const idade = (l) => l.reduce((m, x) => Math.max(m, x.idade_min), 0);
  return {
    pendentes: p.length,
    pendente_mais_antigo_min: idade(p),
    falhas_permanentes: f.length,
    falha_mais_antiga_min: idade(f),
    falhas_acima_de_7_dias: f.filter((x) => x.idade_min > 7 * 1440).length,
    ultima_execucao_agendador: ultima ? { fim: new Date(ultima.fim).toISOString(), ha_min: Math.round((agora - ultima.fim) / 60000), processados: ultima.processados } : null,
    lista_pendentes: p,
    lista_falhas: f,
  };
}

module.exports = {
  registrar, processar, reprocessarVencidos, executarAgendador, reativarFalhas, descartar, resumo, hashCadastro,
  FILA, FALHAS, chave, LUA_REGISTRAR, LUA_ATUALIZAR,
};
