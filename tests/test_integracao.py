"""Testes reproduzíveis da integração LP → CRM → Cal.com (somente SIMULAÇÃO).

Requisitos: Node 18+, Python 3.10+, Playwright para Python com Chromium.
Uso:  python3 tests/test_integracao.py            (a partir da raiz do site)

Usa tests/simulador.js (receptor CRM conforme contrato + KV REST simulado) e o script oficial
@calcom/embed-core 1.5.3 (tests/fixtures). Nenhum serviço externo é chamado; nenhuma mensagem é enviada.
Os resultados NÃO comprovam funcionamento com o CRM, o armazenamento ou o Cal.com reais.
"""
import json, os, subprocess, sys, threading, time, urllib.parse, urllib.request
from playwright.sync_api import sync_playwright

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
EMB = open(os.path.join(RAIZ, "tests", "fixtures", "calcom-embed-core-1.5.3.js"), encoding="utf-8").read()
CRON = {"authorization": "Bearer cron-de-teste"}
R = []


def ok(nome, cond, info=""):
    R.append({"teste": nome, "passou": bool(cond), "detalhe": str(info)[:300]})
    print(("PASSOU " if cond else "FALHOU ") + nome + ("" if info == "" else "  → " + str(info)[:300]))


def http(url, headers=None, data=None, method=None):
    r = urllib.request.Request(url, headers=headers or {}, data=data, method=method)
    try:
        with urllib.request.urlopen(r, timeout=30) as x:
            return x.status, x.read().decode(), dict(x.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(), dict(e.headers)


class Ambiente:
    def __init__(self, porta, kv=True, extra_env=None):
        self.P = porta
        self.base = f"http://127.0.0.1:{porta}"
        env = dict(os.environ, **(extra_env or {}))
        self.logf = os.path.join(RAIZ, "tests", f"saida-servidor-{porta}.log")
        self.proc = subprocess.Popen(["node", os.path.join(RAIZ, "tests", "simulador.js"), RAIZ, str(porta)] + (["kv"] if kv else []),
                                     stdout=open(self.logf, "w"), stderr=subprocess.STDOUT, env=env)
        time.sleep(1.3)

    def crm(self, c): return http(f"http://127.0.0.1:{self.P+1}/{c}")[1]
    def kv(self, c): return http(f"http://127.0.0.1:{self.P+2}/{c}")[1]
    def log(self): return json.loads(self.crm("__log"))
    def dump(self): return json.loads(self.kv("__dump"))
    def rec(self, i): return dict(self.dump()["chaves"]).get("{pagag}:cad:" + i)
    def post(self, body): return http(self.base + "/api/cadastro", {"content-type": "application/json"}, json.dumps(body).encode(), "POST")
    def agendador(self, q="", method=None, data=None): return http(self.base + "/api/cadastro-reprocessar" + q, CRON, data, method)
    def fim(self): self.proc.kill()


def cad(n, loja="colombo", nome="Pessoa Sintetica", tel="+5541000000000", cpf=None, **k):
    d = {"external_id": f"pag-agendamento:{loja}:00000000-0000-4000-8000-{n:012d}", "nome": nome, "telefone": tel, "loja": loja,
         "submitted_at": "2026-10-08T12:00:00-03:00", "utm_source": "teste-controlado", "utm_medium": "fixture", "utm_campaign": "aceite-integracao"}
    if cpf: d["cpf"] = cpf
    d.update(k)
    return d


def pagina(b, w, amb, bloquear_cal=False):
    c = b.new_context(viewport={"width": w, "height": 860}, is_mobile=w < 500, has_touch=w < 500)
    pg = c.new_page(); pg.erros = []; pg.iframes = []; pg.abas = []
    pg.on("pageerror", lambda e: pg.erros.append(str(e)))
    c.on("page", lambda x: pg.abas.append(x.url))
    pg.route("https://fonts.googleapis.com/**", lambda r: r.abort())
    if bloquear_cal:
        pg.route("https://app.cal.com/**", lambda r: r.abort()); pg.route("https://cdn.jsdelivr.net/**", lambda r: r.abort())
    else:
        pg.route("https://app.cal.com/embed/embed.js", lambda r: r.fulfill(status=200, content_type="text/javascript", body=EMB))
        pg.route("https://app.cal.com/espacodocelular/**", lambda r: (pg.iframes.append(r.request.url), r.fulfill(status=200, content_type="text/html", body="ok")))
    return c, pg


def preencher(pg, amb, loja, tel):
    pg.goto(amb.base + f"/pre-analise.html?loja={loja}&utm_source=teste-controlado"); pg.wait_for_timeout(300)
    pg.fill("#paNome", "Pessoa Sintetica"); pg.type("#paTel", tel); pg.type("#paCpf", "52998224725")


def sub(pg): return pg.evaluate("JSON.parse(localStorage.getItem('edc_pag_agendamento_v1'))")


# =============================== SERVIDOR / CONTRATO ===============================
A = Ambiente(9500, kv=True)
try:
    A.crm("__reset"); A.crm("__modo/ok")
    st, b, h = A.post(cad(1, cpf="52998224725"))
    j = json.loads(b); L = A.log()["recebidos"]; e = L[-1]
    ok("C1 cadastro Colombo: 200, persistido+entregue, comprovante guardado", st == 200 and j["entregue"] and j["persistido"] and A.rec(cad(1)["external_id"])["comprovante"]["receipt_id"], b)
    ok("C2 URL = base/api/v1/webhooks/pag-agendamento/{sourceId}/cadastro e assinatura válida", e["status"] == 200 and e["assinatura_valida"])
    ok("C3 X-Pag-Agendamento-Signature em hexadecimal SEM prefixo, sobre os bytes enviados", e["assinatura_hex_sem_prefixo"] and e["assinatura_valida"])
    ok("C4 form-urlencoded: '+' do telefone vira %2B; sem chaves repetidas", "telefone=%2B5541000000000" in e["raw"] and not e["repetidas"], e["raw"][:110])
    ok("C5 origem/tag fixas, UTMs presentes, UTM vazia omitida, consentimento NÃO enviado", e["body"]["origem_entrada"] == "LP + Agendamento" and e["body"]["tag_origem"] == "PAG+AGENDAMENTO" and e["body"]["utm_source"] == "teste-controlado" and "utm_term" not in e["body"] and "consentimento_contato" not in e["body"])
    ok("C6 Idempotency-Key = external_id", e["idem"] == cad(1)["external_id"])
    r1 = A.rec(cad(1)["external_id"])
    ok("C7 após confirmação: payload (com CPF) apagado; fica só comprovante", r1["payload"] is None and "cpf" not in json.dumps(r1))

    for i, modo, motivo in [(2, "html200", "resposta_nao_json"), (3, "persisted_false", "persisted_nao_true"), (4, "persisted_texto", "persisted_nao_true"),
                            (5, "id_divergente", "id_divergente"), (6, "so_ok", "sem_data"), (7, "raiz", "sem_data"), (8, "json_invalido", "json_invalido")]:
        A.crm("__modo/" + modo); st, b, _ = A.post(cad(i)); r = A.rec(cad(i)["external_id"])
        ok(f"C8 HTTP 200 com {modo}: NÃO é entrega (payload preservado)", st == 202 and not json.loads(b)["entregue"] and r["status"] == "falha_transitoria" and r["ultimo_motivo"] == motivo and r["payload"], (r["status"], r["ultimo_motivo"]))

    A.crm("__reset"); A.crm("__modo/lento"); st, b, _ = A.post(cad(20))
    r = A.rec(cad(20)["external_id"]); A.crm("__modo/ok"); A.kv("__vencer"); A.agendador()
    L = [x for x in A.log()["recebidos"] if x["body"].get("external_id") == cad(20)["external_id"]]
    ok("C9 CRM grava mas a resposta se perde (timeout): reenvio com o mesmo id, CRM reconhece repetição, conclui uma vez",
       r["ultimo_motivo"] == "timeout" and len(L) == 2 and not L[0]["repeticao"] and L[1]["repeticao"] and A.rec(cad(20)["external_id"])["status"] == "concluido", [(x["modo"], x.get("repeticao")) for x in L])

    A.crm("__reset"); A.crm("__modo/ok"); A.post(cad(30, nome="Pessoa A")); st, b, _ = A.post(cad(30, nome="Pessoa B"))
    ok("C10 mesmo id com conteúdo diferente na LP: 409, original preservado, nada reenviado", st == 409 and len(A.log()["recebidos"]) == 1 and A.log()["recebidos"][0]["body"]["nome"] == "Pessoa A")

    for i, modo, motivo in [(40, "auth", "permanente_auth"), (41, "desligada", "permanente_fonte")]:
        A.crm("__modo/" + modo); A.post(cad(i)); r = A.rec(cad(i)["external_id"])
        ok(f"C11 {modo}: falha permanente visível, sem loop", r["status"] == "falha_permanente" and r["ultimo_motivo"] == motivo and r["payload"])
    A.crm("__modo/limite"); A.post(cad(42)); r = A.rec(cad(42)["external_id"])
    ok("C12 429: transitória com backoff", r["status"] == "falha_transitoria" and r["proximo_envio"] > time.time() * 1000)

    # conflito vindo do CRM (mesmo id já guardado lá com outro conteúdo)
    A.crm("__reset"); A.crm("__modo/ok"); A.post(cad(50, nome="Original"))
    http(f"http://127.0.0.1:{A.P+2}", {"authorization": "Bearer token-kv-teste", "content-type": "application/json"}, json.dumps(["DEL", "{pagag}:cad:" + cad(50)["external_id"]]).encode(), "POST")
    A.post(cad(50, nome="Divergente")); r = A.rec(cad(50)["external_id"])
    ok("C13 CRM responde 409 (conteúdo divergente): falha permanente 'conflito', sem reenvio em loop", r["status"] == "falha_permanente" and r["ultimo_motivo"] == "conflito")

    st, b, _ = A.agendador("?resumo=1"); s = json.loads(b)
    ok("C14 resumo: contagens, idade e última execução, sem dados pessoais",
       s["falhas_permanentes"] >= 3 and "pendente_mais_antigo_min" in s and s["ultima_execucao_agendador"] and not any(x in b for x in ["Pessoa", "+5541", "52998224725"]), {k: s[k] for k in ["pendentes", "falhas_permanentes", "ultima_execucao_agendador"]})
    ok("C15 resumo exige credencial do agendador", http(A.base + "/api/cadastro-reprocessar?resumo=1")[0] == 401)

    A.crm("__modo/ok"); id40 = cad(40)["external_id"]
    st, b, _ = A.agendador("?reativar=" + urllib.parse.quote(id40), "POST", b"")
    A.agendador("?reativar=1", "POST", b"")
    n = len([x for x in A.log()["recebidos"] if x["body"].get("external_id") == id40 and x["status"] == 200])
    ok("C16 correção da autenticação → reativação → entrega única; reativar de novo não duplica", A.rec(id40)["status"] == "concluido" and n == 1, b)

    A.crm("__modo/auth"); A.post(cad(45)); A.post(cad(46)); id45 = cad(45)["external_id"]
    st, b, _ = A.agendador("?descartar=" + urllib.parse.quote(id45), "POST", b"")
    st2, b2, _ = A.agendador("?descartar=" + urllib.parse.quote(id45) + "&confirmar=1", "POST", b"")
    r = A.rec(id45)
    ok("C17 descarte só com confirmação explícita; apaga dados pessoais e sai das filas", st == 400 and st2 == 200 and r["status"] == "descartado" and r["payload"] is None and id45 not in A.dump()["filas"].get("{pagag}:falhas", []))

    d = A.dump(); exp = d["expira"]
    ok("C18 retenção: concluído expira em 180 dias; falha permanente não expira sozinha",
       170 * 86400e3 < exp["{pagag}:cad:" + cad(1)["external_id"]] - time.time() * 1000 < 181 * 86400e3 and "{pagag}:cad:" + cad(46)["external_id"] not in exp and A.rec(cad(46)["external_id"])["status"] == "falha_permanente")
    ok("C19 gravação usa scripts atômicos (EVAL) para registro+fila e transições", d["comandos"].get("EVAL", 0) > 10 and d["comandos"].get("ZADD", 0) == 0, d["comandos"])

    A.crm("__reset"); A.crm("__modo/lento"); res = []
    ts = [threading.Thread(target=lambda: res.append(A.post(cad(60)))) for _ in range(3)]
    [t.start() for t in ts]; [t.join() for t in ts]
    ok("C20 3 requisições simultâneas do mesmo cadastro: 1 envio ao CRM", len(A.log()["recebidos"]) == 1, sorted(json.loads(x[1])["status"] for x in res))

    A.crm("__modo/lento"); A.post(cad(61)); A.kv("__vencer"); out = []
    ts = [threading.Thread(target=lambda: out.append(A.agendador())) for _ in range(2)]
    [t.start() for t in ts]; [t.join() for t in ts]
    ok("C21 duas execuções simultâneas do agendador: uma ignorada (sem sobreposição)", any("execucao_anterior_em_andamento" in x[1] for x in out), [x[1][:70] for x in out])

    A.crm("__reset"); A.crm("__modo/falha"); A.post(cad(70)); A.crm("__modo/ok"); A.agendador()
    ok("C22 agendador respeita o backoff: não reenvia antes do horário", len(A.log()["recebidos"]) == 1)
    A.kv("__vencer"); A.agendador()
    ok("C23 no horário: reenvia e conclui", A.rec(cad(70)["external_id"])["status"] == "concluido")

    st, b, _ = A.post(cad(80, loja="curitiba")); st2, b2, _ = A.post({k: v for k, v in cad(81).items() if k != "loja"})
    ok("C24 loja desconhecida ou ausente: 422, nada enviado, sem padrão", st == 422 and st2 == 422)
finally:
    A.fim()

# configuração ausente: não inventa URL nem sourceId
B = Ambiente(9600, kv=True, extra_env={"SIM_SEM_SOURCE": "1"})
try:
    B.crm("__reset")
    st, b, _ = B.post(cad(90))
    r = B.rec(cad(90)["external_id"])
    ok("C25 sem CRM_SOURCE_ID: nada é enviado, cadastro fica pendente 'config_pendente' sob guarda da LP", st == 202 and not B.log()["recebidos"] and r["ultimo_motivo"] == "config_pendente" and r["payload"], b)
finally:
    B.fim()

# =============================== PÁGINA (navegador) ===============================
A = Ambiente(9700, kv=True)
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        for w, disp in [(1280, "desktop"), (390, "celular")]:
            A.crm("__reset"); A.crm("__modo/ok")
            c, pg = pagina(b, w, A); preencher(pg, A, "colombo", "41000000001")
            opts = pg.eval_on_selector_all("#paLoja option", "os=>os.map(o=>o.value)")
            pg.click(".pa-submit"); pg.wait_for_selector(".pa-cta", timeout=15000); pg.wait_for_timeout(800)
            msg = pg.inner_text(".pa-cal-msg")
            ok(f"P1 [{disp}] Colombo: lista única com Colombo; cadastro confirmado antes da mensagem de recebido; sem agenda de outra loja",
               opts == ["", "colombo", "itajai", "navegantes", "camboriu"] and sub(pg)["enviado"] and "Seus dados foram recebidos" in msg and pg.get_attribute(".pa-cta", "data-cal-link") is None, msg)
            ok(f"P2 [{disp}] Colombo sem WhatsApp: botão desativado, sem link", pg.get_attribute(".pa-cta", "href") is None and pg.get_attribute(".pa-cta", "aria-disabled") == "true")
            c.close()

            A.crm("__reset")
            c, pg = pagina(b, w, A); preencher(pg, A, "itajai", "47000000002")
            pg.evaluate("()=>{const f=document.getElementById('paForm');f.requestSubmit();f.requestSubmit();}")
            pg.wait_for_timeout(1500); antes = len(A.log()["recebidos"]); pg.wait_for_selector(".pa-cta", timeout=15000)
            u = pg.get_attribute(".pa-cta", "href") or ""; q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(u).query))
            idp = sub(pg)["payload"]["external_id"]
            ok(f"P3 [{disp}] cadastro enviado antes do botão; clique duplo: 1 envio", antes == 1 and len(A.log()["recebidos"]) == 1 and not pg.abas)
            ok(f"P4 [{disp}] botão leva ao WhatsApp da loja escolhida com nome, telefone e loja", urllib.parse.urlparse(u).netloc == "wa.me" and urllib.parse.urlparse(u).path == "/554799481741" and "Pessoa Sintetica" in q.get("text", "") and "Itajaí" in q.get("text", "") and "FINALIZE A COMPRA COM VENDEDOR" in pg.inner_text(".pa-cta"), u)
            ok(f"P5 [{disp}] nenhum CPF no link do WhatsApp", "52998224725" not in u.replace(".", "").replace("-", "") and "cpf" not in u.lower())
            pg.goto(A.base + "/pre-analise.html?loja=itajai"); pg.wait_for_timeout(700)
            ok(f"P6 [{disp}] retomada após recarregar: mesmo id, sem novo envio", pg.locator(".pa-cta").count() == 1 and sub(pg)["payload"]["external_id"] == idp and len(A.log()["recebidos"]) == 1)
            ok(f"P7 [{disp}] sem erros de JavaScript", not pg.erros, pg.erros)
            c.close()

            A.crm("__reset"); A.crm("__modo/falha")
            c, pg = pagina(b, w, A); preencher(pg, A, "navegantes", "47000000003"); pg.click(".pa-submit"); pg.wait_for_timeout(1500)
            idf = sub(pg)["payload"]["external_id"]; c.close()  # aba fechada
            A.crm("__modo/ok"); A.kv("__vencer"); A.agendador()
            ok(f"P8 [{disp}] aba fechada + CRM fora + sem tráfego: o agendador entrega depois, mesmo id", A.rec(idf)["status"] == "concluido" and [x["body"]["external_id"] for x in A.log()["recebidos"] if x["status"] == 200] == [idf])

            c, pg = pagina(b, w, A); pg.goto(A.base + "/pre-analise.html"); pg.fill("#paNome", "Pessoa Sintetica"); pg.type("#paTel", "47000000004"); pg.type("#paCpf", "52998224725"); pg.click(".pa-submit"); pg.wait_for_timeout(500)
            ok(f"P9 [{disp}] sem loja: não envia e não escolhe padrão", pg.eval_on_selector("#paLoja", "e=>e.value") == "" and pg.locator("#paForm").count() == 1)
            c.close()

            c, pg = pagina(b, w, A, bloquear_cal=True); preencher(pg, A, "camboriu", "47000000005"); pg.click(".pa-submit"); pg.wait_for_selector(".pa-cta", timeout=15000)
            u10 = pg.get_attribute(".pa-cta", "href") or ""
            ok(f"P10 [{disp}] Camboriú: WhatsApp 5547997641397; página não carrega Cal.com", urllib.parse.urlparse(u10).path == "/5547997641397" and pg.evaluate("typeof window.Cal") == "undefined", u10)
            c.close()
        b.close()
finally:
    A.fim()

# sem armazenamento (PERSISTENCIA_OBRIGATORIA=1) e CRM fora: a página não afirma recebimento
A = Ambiente(9800, kv=False, extra_env={"PERSISTENCIA_OBRIGATORIA": "1"})
try:
    A.crm("__modo/falha")
    st, b, h = A.post(cad(95))
    ok("S1 sem armazenamento + CRM fora: 503 persistencia_indisponivel, persistido=false", st == 503 and json.loads(b)["erro"] == "persistencia_indisponivel" and json.loads(b)["persistido"] is False, b)
    with sync_playwright() as p:
        bw = p.chromium.launch(); c, pg = pagina(bw, 390, A, bloquear_cal=True); preencher(pg, A, "colombo", "41000000006"); pg.click(".pa-submit")
        pg.wait_for_selector(".pa-cta", timeout=15000); pg.wait_for_timeout(9000)
        t = pg.inner_text(".pa-registro"); m = pg.inner_text(".pa-cal-msg")
        ok("S2 sem confirmação do CRM a tela não diz 'recebidos' nem 'ainda estamos registrando'", "Ainda estamos registrando" not in t and "recebidos" not in m, (t, m))
        pg.screenshot(path=os.path.join(RAIZ, "tests", "evidencia-sem-persistencia-390.png"))
        bw.close()
finally:
    A.fim()

# logs
todos = "".join(open(os.path.join(RAIZ, "tests", f)).read() for f in os.listdir(os.path.join(RAIZ, "tests")) if f.startswith("saida-servidor"))
ok("L1 logs sem CPF, telefone, nome ou segredos; alertas marcados",
   '"nivel":"alerta"' in todos and not any(x in todos for x in ["52998224725", "+5541", "4100000000", "4700000000", "Pessoa", "segredo-cadastro", "token-kv", "cron-de-teste"]))

print(f"\nRESUMO: {sum(r['passou'] for r in R)} de {len(R)} passaram")
json.dump(R, open(os.path.join(RAIZ, "tests", "resultado.json"), "w"), ensure_ascii=False, indent=1)
sys.exit(0 if all(r["passou"] for r in R) else 1)
