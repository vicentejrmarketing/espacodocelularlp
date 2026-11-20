// Testes da busca de loja por CEP com os serviços externos SIMULADOS (sem internet).
// Uso: node tests/test_loja_proxima.js
const path = require("path");
const api = require(path.join(__dirname, "..", "api", "loja-proxima.js"));
let cenario = {};
global.fetch = async (url) => {
  const resp = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
  if (url.includes("viacep")) return cenario.viacep ? cenario.viacep(url) : resp(503, null);
  if (url.includes("brasilapi")) return cenario.brasilapi ? cenario.brasilapi(url) : resp(503, null);
  if (url.includes("nominatim")) return cenario.nominatim ? cenario.nominatim(decodeURIComponent(url)) : resp(503, null);
  throw new Error("url inesperada " + url);
};
const R = (status, json) => () => ({ ok: status < 300, status, json: async () => json });
function chamar(cep) {
  return new Promise((ok) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { ok({ status: this.statusCode, corpo: JSON.parse(b), cache: this.headers["Cache-Control"] }); } };
    api({ method: "GET", url: "/api/loja-proxima?cep=" + cep }, res);
  });
}
let falhas = 0, total = 0;
function ok(nome, cond, det) { total++; if (!cond) falhas++; console.log((cond ? "PASSOU " : "FALHOU ") + nome + (cond ? "" : "  → " + JSON.stringify(det))); }
const cidade = (nome, uf, rua) => R(200, { cep: "x", logradouro: rua || "", bairro: "Centro", localidade: nome, uf });
const ponto = (lat, lon) => () => ({ ok: true, status: 200, json: async () => [{ lat: String(lat), lon: String(lon) }] });

(async () => {
  cenario = { viacep: cidade("Florianópolis", "SC", "Rua Deodoro"), nominatim: ponto(-27.5966, -48.5512) };
  let r = await chamar("88010-020");
  ok("1 CEP do centro de Florianópolis -> Florianópolis – Centro (a mais perto das 2 da cidade)", r.corpo.loja.codigo === "florianopolis" && r.corpo.criterio === "cidade", r.corpo);

  cenario = { viacep: cidade("Navegantes", "SC"), nominatim: ponto(-26.9001, -48.6555) };
  r = await chamar("88370000");
  ok("2 CEP de Navegantes -> Navegantes (não Itajaí, mesmo sendo vizinhas)", r.corpo.loja.codigo === "navegantes", r.corpo);

  cenario = { viacep: cidade("Balneário Camboriú", "SC", "Avenida Atlântica"), nominatim: ponto(-26.9906, -48.6347) };
  r = await chamar("88330000");
  ok("3 Balneário Camboriú -> loja mais próxima é Camboriú", r.corpo.loja.codigo === "camboriu" && r.corpo.criterio === "distancia" && r.corpo.distancia_km < 10, r.corpo);

  cenario = { viacep: cidade("São José", "SC"), nominatim: ponto(-27.6136, -48.6366) };
  r = await chamar("88101000");
  ok("4 São José -> Floripa Shopping (fica em São José)", r.corpo.loja.codigo === "florianopolis-shopping" && r.corpo.criterio === "cidade", r.corpo);

  cenario = { viacep: cidade("Blumenau", "SC"), nominatim: ponto(-26.8800, -49.0950) };
  r = await chamar("89065000");
  ok("5 Blumenau, bairro Salto Norte -> Blumenau – Norte Shopping", r.corpo.loja.codigo === "blumenau-norte" && r.corpo.ranking.length === 25, r.corpo);

  cenario = { viacep: cidade("Joinville", "SC"), nominatim: ponto(-26.2600, -48.8200) };
  r = await chamar("89226000");
  ok("5b Joinville, Aventureiro -> Joinville Loja 3", r.corpo.loja.codigo === "joinville-3", r.corpo);

  cenario = { viacep: cidade("Gaspar", "SC"), nominatim: ponto(-26.9310, -48.9590) };
  r = await chamar("89110000");
  ok("5c Gaspar (sem loja) -> Blumenau ou Brusque, a mais perto", ["blumenau", "brusque"].includes(r.corpo.loja.codigo) && r.corpo.criterio === "distancia", r.corpo);

  cenario = { viacep: cidade("Sapucaia do Sul", "RS"), nominatim: ponto(-29.8410, -51.1450) };
  r = await chamar("93210000");
  ok("5d Sapucaia do Sul (RS) -> Esteio", r.corpo.loja.codigo === "esteio", r.corpo);

  cenario = { viacep: cidade("Pinhais", "PR"), nominatim: ponto(-25.4440, -49.1920) };
  r = await chamar("83320000");
  ok("5e Pinhais (PR) -> Curitiba ou Colombo", ["curitiba", "colombo"].includes(r.corpo.loja.codigo), r.corpo);

  cenario = { viacep: cidade("Camboriú", "SC") };
  r = await chamar("88340000");
  ok("6 sem coordenadas, mas cidade com loja -> ainda acha pela cidade", r.status === 200 && r.corpo.loja.codigo === "camboriu" && r.corpo.distancia_km === null, r);

  cenario = { viacep: R(200, { erro: "true" }) };
  r = await chamar("99999999");
  ok("7 CEP inexistente -> 404 cep_nao_encontrado", r.status === 404 && r.corpo.erro === "cep_nao_encontrado", r);

  cenario = { brasilapi: R(200, { cep: "88010020", city: "Florianópolis", state: "SC", neighborhood: "Centro", street: "Rua Deodoro", location: { coordinates: { latitude: "-27.59", longitude: "-48.55" } } }) };
  r = await chamar("88010020");
  ok("8 ViaCEP fora do ar -> usa BrasilAPI", r.status === 200 && r.corpo.loja.codigo === "florianopolis", r);

  cenario = {};
  r = await chamar("88010020");
  ok("9 todos os serviços fora do ar -> 503, sem guardar em cache", r.status === 503 && r.cache === "no-store", r);

  r = await chamar("123");
  ok("10 CEP inválido -> 400", r.status === 400 && r.corpo.erro === "cep_invalido", r);

  cenario = { viacep: cidade("Ilhota", "SC") };
  r = await chamar("88320000");
  ok("11 cidade sem loja e sem coordenadas -> 503 localizacao_indisponivel", r.status === 503 && r.corpo.erro === "localizacao_indisponivel", r);

  console.log(`\nRESUMO: ${total - falhas} de ${total} passaram`);
  process.exit(falhas ? 1 : 0);
})();
