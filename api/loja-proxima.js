// Loja mais próxima pelo CEP.
//   GET /api/loja-proxima?cep=88010020
//   -> {ok, endereco:{cidade,uf,bairro}, loja:{codigo,nome}, distancia_km, criterio:"cidade"|"distancia", ranking:[{codigo,nome,distancia_km}]}
// Regra: se a pessoa mora numa cidade onde temos loja, é essa loja (com várias, a mais perto). Senão, a de menor distância em linha reta.
// Serviços públicos usados (sem chave): ViaCEP (endereço do CEP), BrasilAPI (endereço/coordenadas, reserva)
// e Nominatim/OpenStreetMap (coordenadas da cidade). O CEP não é guardado nem registrado em log.

const LOJAS = require("../lojas.js");
const UA = "EspacoDoCelular-LP/1.0 (busca de loja por CEP)";

function norm(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
function km(a, b) {
  const R = 6371, r = (x) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
async function pegarJSON(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 4000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    if (!r.ok) return { status: r.status, json: null };
    return { status: r.status, json: await r.json().catch(() => null) };
  } catch (e) {
    return { status: 0, json: null };
  } finally {
    clearTimeout(t);
  }
}

// Endereço do CEP: ViaCEP; se falhar, BrasilAPI (que às vezes já traz coordenadas)
async function endereco(cep) {
  const v = await pegarJSON("https://viacep.com.br/ws/" + cep + "/json/");
  if (v.json && !v.json.erro && v.json.localidade) {
    return { cidade: v.json.localidade, uf: v.json.uf, bairro: v.json.bairro || "", rua: v.json.logradouro || "" };
  }
  const b = await pegarJSON("https://brasilapi.com.br/api/cep/v2/" + cep);
  if (b.json && b.json.city) {
    const c = b.json.location && b.json.location.coordinates;
    const lat = c && Number(c.latitude), lon = c && Number(c.longitude);
    return { cidade: b.json.city, uf: b.json.state, bairro: b.json.neighborhood || "", rua: b.json.street || "", lat: isFinite(lat) && lat ? lat : undefined, lon: isFinite(lon) && lon ? lon : undefined };
  }
  if (v.json && v.json.erro) return null; // CEP não existe
  if ((v.status >= 400 && v.status < 500) || (b.status >= 400 && b.status < 500)) return null;
  throw new Error("servico_indisponivel");
}

// Coordenadas: do endereço (rua) e, se não achar, do centro da cidade
async function coordenadas(e) {
  if (e.lat && e.lon) return { lat: e.lat, lon: e.lon };
  const tentativas = [];
  if (e.rua) tentativas.push(e.rua + ", " + e.cidade + ", " + e.uf + ", Brasil");
  tentativas.push(e.cidade + ", " + e.uf + ", Brasil");
  for (const q of tentativas) {
    const n = await pegarJSON("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=" + encodeURIComponent(q), 5000);
    if (Array.isArray(n.json) && n.json[0]) {
      const lat = Number(n.json[0].lat), lon = Number(n.json[0].lon);
      if (isFinite(lat) && isFinite(lon)) return { lat, lon };
    }
  }
  return null;
}

function responder(res, status, corpo, cache) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // mesma resposta para o mesmo CEP: a Vercel guarda por 1 dia e evita repetir as consultas
  res.setHeader("Cache-Control", cache ? "public, s-maxage=86400, stale-while-revalidate=604800" : "no-store");
  res.end(JSON.stringify(corpo));
}

async function buscar(cep) {
  const lojas = Object.values(LOJAS).filter((l) => l.vitrine);
  const e = await endereco(cep);
  if (!e) return { status: 404, corpo: { ok: false, erro: "cep_nao_encontrado" } };
  const base = { ok: true, endereco: { cidade: e.cidade, uf: e.uf, bairro: e.bairro } };

  // lojas que atendem a cidade do CEP (cidade da loja ou cidades extras em "cidadesBusca")
  const naCidade = lojas.filter(
    (l) => norm(l.uf) === norm(e.uf) && [l.cidade].concat(l.cidadesBusca || []).some((c) => norm(c) === norm(e.cidade))
  );
  const pos = await coordenadas(e);
  const ranking = pos
    ? lojas.map((l) => ({ codigo: l.codigo, nome: l.nome, distancia_km: Math.round(km(pos, l) * 10) / 10 })).sort((a, b) => a.distancia_km - b.distancia_km)
    : [];
  // várias lojas na mesma cidade: a mais perto do endereço (sem coordenadas, a primeira da lista)
  const maisPerto = ranking.find((r) => naCidade.some((l) => l.codigo === r.codigo));
  const daCidade = naCidade.length ? (maisPerto ? LOJAS[maisPerto.codigo] : naCidade[0]) : null;

  if (daCidade) {
    const d = ranking.find((r) => r.codigo === daCidade.codigo);
    return { status: 200, corpo: Object.assign(base, { loja: { codigo: daCidade.codigo, nome: daCidade.nome }, distancia_km: d ? d.distancia_km : null, criterio: "cidade", ranking }) };
  }
  if (!ranking.length) return { status: 503, corpo: { ok: false, erro: "localizacao_indisponivel", endereco: base.endereco } };
  const p = ranking[0];
  return { status: 200, corpo: Object.assign(base, { loja: { codigo: p.codigo, nome: p.nome }, distancia_km: p.distancia_km, criterio: "distancia", ranking }) };
}

module.exports = async function (req, res) {
  if (req.method !== "GET") return responder(res, 405, { ok: false, erro: "metodo" });
  const cep = String(new URL(req.url, "http://x").searchParams.get("cep") || "").replace(/\D/g, "");
  if (!/^\d{8}$/.test(cep)) return responder(res, 400, { ok: false, erro: "cep_invalido" });
  try {
    const r = await buscar(cep);
    return responder(res, r.status, r.corpo, r.status === 200 || r.status === 404);
  } catch (e) {
    return responder(res, 503, { ok: false, erro: "servico_indisponivel" });
  }
};
module.exports.buscar = buscar;
module.exports.km = km;
