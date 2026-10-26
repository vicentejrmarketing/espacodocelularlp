"""Testes da central de leads (SIMULAÇÃO local: tests/simulador.js com armazenamento KV simulado).
Uso: python3 tests/test_central.py   — não chama nenhum serviço externo."""
import json, os, subprocess, sys, time, urllib.request, uuid, base64
from playwright.sync_api import sync_playwright
RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORTA = 9920; B = f"http://127.0.0.1:{PORTA}"
res = []
def ok(nome, cond, det=""):
    res.append(bool(cond)); print(("PASSOU " if cond else "FALHOU ") + nome + ("" if cond else f"  → {det}"))
def req(m, p, body=None, h=None):
    d = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(B + p, data=d, method=m, headers=h or {"content-type": "application/json"})
    try:
        with urllib.request.urlopen(r) as x: t = x.read().decode(); return x.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t = e.read().decode(); return e.code, (json.loads(t) if t else None)
# Contas de TESTE criadas pelo simulador (as reais ficam só na Vercel)
CRED = {"itajai": ("itajai@teste.invalid", "Teste-Itajai-1"), "navegantes": ("navegantes@teste.invalid", "Teste-Navegantes-1"),
        "camboriu": ("camboriu@teste.invalid", "Teste-Camboriu-1"), "geral": ("gerente", "Teste-Gerente-1")}
def login_email(e, s, ip="9.9.9.9"): return req("POST", "/api/central", {"email": e, "senha": s}, {"content-type": "application/json", "x-forwarded-for": ip})
def login(a, s=None, ip="9.9.9.9"): return login_email(CRED[a][0], CRED[a][1] if s is None else s, ip)
def painel(t): return req("GET", "/api/central", None, {"authorization": "Bearer " + t})

# Modo: "kv" (padrão) ou "supabase" (precisa de SIM_SUPA_PG apontando para um Postgres com supabase/central.sql aplicado)
MODO = sys.argv[1] if len(sys.argv) > 1 else "kv"
print("MODO:", MODO)
sim = subprocess.Popen(["node", os.path.join(RAIZ, "tests", "simulador.js"), RAIZ, str(PORTA), "kv"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       env=dict(os.environ) if MODO == "supabase" else {k: v for k, v in os.environ.items() if not k.startswith("SIM_SUPA")})
try:
    time.sleep(1.5)
    ids = {}
    for loja, tel in [("itajai", "47999990001"), ("navegantes", "47999990002"), ("camboriu", "47999990003")]:
        i = f"pag-agendamento:{loja}:{uuid.uuid4()}"; ids[loja] = i
        req("POST", "/api/cadastro", {"external_id": i, "nome": "Cliente " + loja, "telefone": "+55" + tel, "cpf": "52998224725", "loja": loja, "submitted_at": "2026-10-24T14:00:00-03:00"})
    req("POST", "/api/cadastro", {"external_id": ids["itajai"], "nome": "Cliente itajai", "telefone": "+5547999990001", "cpf": "52998224725", "loja": "itajai", "submitted_at": "2026-10-24T14:00:00-03:00"})
    for loja, org, ip, i in [("itajai", "site", "1.1.1.1", ""), ("itajai", "pre-analise", "2.2.2.2", ids["itajai"]), ("navegantes", "site", "3.3.3.3", ""), ("navegantes", "site", "3.3.3.3", ""), ("camboriu", "pre-analise", "4.4.4.4", ids["itajai"])]:
        req("POST", "/api/clique", {"loja": loja, "origem": org, "id": i}, {"content-type": "text/plain", "x-forwarded-for": ip})
    T = {a: login(a)[1]["token"] for a in ["itajai", "navegantes", "camboriu", "geral"]}
    ok("L0 login por e-mail devolve a loja certa (e-mail com maiúsculas/espaços também)", login_email("  Itajai@Teste.INVALID ", "Teste-Itajai-1")[1].get("acesso") == "itajai")
    D = {a: painel(t)[1] for a, t in T.items()}
    for a in ["itajai", "navegantes", "camboriu"]:
        ok(f"L1 {a} vê só os próprios leads", [l["loja"] for l in D[a]["leads"]] == [a] and list(D[a]["cliques"]) == [a], D[a]["leads"])
    ok("L2 reenvio do mesmo formulário não duplica o lead", len(D["itajai"]["leads"]) == 1)
    ok("L3 cliques por loja e por botão", (D["itajai"]["cliques"]["itajai"]["site"], D["itajai"]["cliques"]["itajai"]["pre-analise"]) == (1, 1) and D["navegantes"]["cliques"]["navegantes"]["site"] == 1 and D["camboriu"]["cliques"]["camboriu"]["pre-analise"] == 1)
    ok("L4 lead marcado como 'clicou no WhatsApp' só pelo botão da própria loja", D["itajai"]["leads"][0].get("clicou_whatsapp_em") and not D["camboriu"]["leads"][0].get("clicou_whatsapp_em"))
    ok("L5b usuário gerente com senha de loja é recusado; e-mail extra de gerente da Vercel funciona", login_email("gerente", "Teste-Itajai-1")[0] == 401 and login_email("dono@teste.invalid", "senha-geral-teste")[1].get("acesso") == "geral")
    ok("L5 gerente vê todas as lojas", sorted({l["loja"] for l in D["geral"]["leads"]}) == ["camboriu", "itajai", "navegantes"])
    ok("L6 senha de outra loja, senha errada e e-mail desconhecido são recusados", login("itajai", "Teste-Navegantes-1")[0] == 401 and login("camboriu", "teste-camboriu-1")[0] == 401 and login_email("x@y.com", "Teste-Itajai-1")[0] == 401)
    c, sig = T["itajai"].split("."); d = json.loads(base64.urlsafe_b64decode(c + "==")); d["a"] = "geral"
    fake = base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=") + "." + sig
    ok("L7 sem token ou com token adulterado: 401", painel("")[0] == 401 and painel(fake)[0] == 401)
    codes = [login("camboriu", "errada%d" % n, "7.7.7.7")[0] for n in range(11)]
    ok("L8 força bruta bloqueia após 10 erros (mesmo com a senha certa)", codes[-1] == 429 and login("camboriu", None, "7.7.7.7")[0] == 429)
    if MODO == "supabase":
        dump = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORTA + 2}/__dump").read())
        ok("S0 no modo Supabase nada da central vai para o KV", not any(k.endswith("_central") for k in dump["comandos"]), dump["comandos"])
    def patch(t, body): return req("PATCH", "/api/central", body, {"content-type": "application/json", "authorization": "Bearer " + t})
    ok("T1 lead novo chega com status 'novo'", all(l["status"] == "novo" for l in D["geral"]["leads"]), [l["status"] for l in D["geral"]["leads"]])
    ok("T2 loja muda o status do próprio lead", patch(T["itajai"], {"id": ids["itajai"], "status": "em_atendimento"})[0] == 200 and painel(T["itajai"])[1]["leads"][0]["status"] == "em_atendimento")
    ok("T3 loja NÃO muda lead de outra loja", patch(T["itajai"], {"id": ids["navegantes"], "status": "comprou", "produto": "Redmi", "valor": 10})[0] == 404 and painel(T["navegantes"])[1]["leads"][0]["status"] == "novo")
    ok("T4 status inválido e sem login são recusados", patch(T["itajai"], {"id": ids["itajai"], "status": "aprovado"})[0] == 422 and req("PATCH", "/api/central", {"id": ids["itajai"], "status": "comprou"})[0] == 401)
    ok("T5 gerente muda status de qualquer loja", patch(T["geral"], {"id": ids["camboriu"], "status": "recusado", "motivo": "Sem entrada"})[0] == 200 and painel(T["camboriu"])[1]["leads"][0]["status"] == "recusado")
    ok("T6 Recusado sem motivo é recusado pelo servidor", patch(T["itajai"], {"id": ids["itajai"], "status": "recusado", "motivo": "  "})[1].get("erro") == "motivo_obrigatorio")
    ok("T7 Comprou sem produto ou sem valor é recusado", patch(T["itajai"], {"id": ids["itajai"], "status": "comprou", "valor": 100})[1].get("erro") == "produto_obrigatorio" and patch(T["itajai"], {"id": ids["itajai"], "status": "comprou", "produto": "Redmi", "valor": 0})[1].get("erro") == "valor_obrigatorio")
    s7 = patch(T["itajai"], {"id": ids["itajai"], "status": "comprou", "produto": "Redmi Note 15 256GB", "valor": 1899.9})[0]
    L = painel(T["itajai"])[1]["leads"][0]
    ok("T8 Comprou com produto e valor fica salvo", s7 == 200 and L["compra_produto"] == "Redmi Note 15 256GB" and float(L["compra_valor"]) == 1899.9, L)
    patch(T["itajai"], {"id": ids["itajai"], "status": "em_atendimento"})
    L = painel(T["itajai"])[1]["leads"][0]
    ok("T9 ao sair de Comprou/Recusado os detalhes antigos somem", L["status"] == "em_atendimento" and "compra_produto" not in L and "compra_valor" not in L, L)
    ok("L9 clique de loja inválida é recusado", req("POST", "/api/clique", {"loja": "xpto", "origem": "site"}, {"content-type": "text/plain"})[0] == 422)

    with sync_playwright() as p:
        b = p.chromium.launch()
        for w in (1280, 390):
            c = b.new_context(viewport={"width": w, "height": 900}); erros = []
            c.route("https://wa.me/**", lambda r: r.fulfill(status=200, content_type="text/html", body="WA"))
            c.route(lambda u: not u.startswith("http://127.0.0.1") and "wa.me" not in u, lambda r: r.abort())
            pg = c.new_page(); pg.on("pageerror", lambda e: erros.append(str(e)))
            pg.goto(B + "/index.html", wait_until="domcontentloaded"); pg.wait_for_timeout(600)
            pg.locator('a[href*="wa.me/5547997641397"]').first.click(); pg.wait_for_timeout(600)
            ok(f"P1 [{w}px] botão Área da loja no rodapé", pg.locator(".edc-central-acesso a[href='central.html']").count() == 1 and pg.locator(".edc-central-acesso a").is_visible())
            pg.goto(B + "/central.html"); pg.fill("#email", CRED["camboriu"][0]); pg.fill("#senha", CRED["camboriu"][1]); pg.click("#bEntrar"); pg.wait_for_timeout(1200)
            ok(f"P2 [{w}px] clique no site conta para a loja e aparece na central", pg.locator("#painel").is_visible() and pg.inner_text("#cSite") == ("1" if w == 1280 else "2"), pg.inner_text("#cSite"))
            # status pela tela: muda, aparece no filtro e continua depois de recarregar
            sel = pg.locator("#tLeads select.st").first
            inicial = sel.input_value()
            if w == 1280:
                # cancelar a janela volta o status; salvar sem preencher mostra aviso; preenchido salva
                sel.select_option("em_atendimento"); pg.wait_for_timeout(1000); inicial = "em_atendimento"
                sel.select_option("recusado"); pg.wait_for_timeout(300)
                ok(f"P6 [{w}px] Recusado abre a janela com o motivo", pg.locator("#mStatus.aberto #mMotivo").is_visible())
                pg.click("#mCancelar"); pg.wait_for_timeout(300)
                ok(f"P7 [{w}px] cancelar a janela volta o status anterior", sel.input_value() == inicial, sel.input_value())
                sel.select_option("comprou"); pg.wait_for_timeout(300); pg.click("#mSalvar"); pg.wait_for_timeout(300)
                ok(f"P8 [{w}px] Comprou não salva sem preencher", pg.locator("#mStatus.aberto").count() == 1 and "comprou" in pg.inner_text("#mMsg").lower())
                pg.fill("#mProduto", "Redmi Note 15 256GB"); pg.fill("#mValor", "1.899,90"); pg.click("#mSalvar"); pg.wait_for_timeout(1200)
                alvo = "comprou"
            else:
                sel.select_option("em_atendimento"); pg.wait_for_timeout(1200); alvo = "em_atendimento"
            pg.reload(); pg.wait_for_timeout(1500)
            ok(f"P4 [{w}px] status escolhido na lista fica salvo", pg.locator("#tLeads select.st").first.input_value() == alvo, pg.locator("#tLeads select.st").first.input_value())
            if w == 1280:
                tl, tf = pg.inner_text("#tLeads").replace("\xa0", " "), pg.inner_text("#filtroStatus").replace("\xa0", " ")
                ok(f"P9 [{w}px] produto e valor aparecem no lead e no filtro", "R$ 1.899,90" in tl and "Redmi Note 15" in tl and "R$ 1.899,90" in tf, tf)
            pg.locator("#filtroStatus button", has_text="Novo").click(); pg.wait_for_timeout(300)
            ok(f"P5 [{w}px] filtro por status esconde o lead que mudou", pg.locator("#tLeads tbody tr").count() == 0 and "Nenhum lead" in pg.inner_text("#vazio"))
            ok(f"P3 [{w}px] sem erros de JavaScript", not erros, erros)
            c.close()
        b.close()
finally:
    sim.terminate()
print(f"\nRESUMO: {sum(res)} de {len(res)} passaram"); sys.exit(0 if all(res) else 1)
