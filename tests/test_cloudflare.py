"""Teste da versão Cloudflare Pages rodando localmente com o wrangler (sem internet).
Como rodar: veja cloudflare/LEIA-ME.md. Usa as contas de TESTE criadas pelo simulador."""
import os
import json,urllib.request,uuid,urllib.parse
from playwright.sync_api import sync_playwright
B=os.environ.get('CF_URL','http://127.0.0.1:8788')
def req(m,p,body=None,h=None):
    d=json.dumps(body).encode() if body is not None else None
    r=urllib.request.Request(B+p,data=d,method=m,headers=h or {'content-type':'application/json'})
    try:
        with urllib.request.urlopen(r,timeout=30) as x: t=x.read().decode(); return x.status,(json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t=e.read().decode()
        try: return e.code,json.loads(t)
        except Exception: return e.code,t[:200]
res=[]
def ok(n,c,d=''): res.append(bool(c)); print(('PASSOU ' if c else 'FALHOU ')+n+('' if c else f'  → {d}'))
idc=f'pag-agendamento:joinville-3:{uuid.uuid4()}'
s,b=req('POST','/api/cadastro',{'external_id':idc,'nome':'Teste Cloudflare','telefone':'+5547999990009','cpf':'52998224725','loja':'joinville-3','submitted_at':'2026-11-20T21:00:00-03:00'})
ok('C1 formulário enviado (loja nova Joinville 3; 503 config_pendente = CRM ainda não ligado, igual à Vercel)', s in (200,202,502,503), (s,b))
s,_=req('POST','/api/clique',{'loja':'joinville-3','origem':'pre-analise','id':idc},{'content-type':'text/plain','cf-connecting-ip':'1.2.3.4'})
ok('C2 clique contado (204)', s==204, s)
s,b=req('POST','/api/central',{'email':'gerente','senha':'Teste-Gerente-1'},{'content-type':'application/json','cf-connecting-ip':'5.5.5.5'})
ok('C3 login do gerente (conferido no banco)', s==200 and b.get('acesso')=='geral', (s,b)); tok=b.get('token') if isinstance(b,dict) else ''
s,b=req('POST','/api/central',{'email':'gerente','senha':'errada'},{'content-type':'application/json','cf-connecting-ip':'5.5.5.6'})
ok('C4 senha errada recusada', s==401, (s,b))
s,D=req('GET','/api/central',None,{'authorization':'Bearer '+tok})
lead=[l for l in (D or {}).get('leads',[]) if l['id']==idc]
ok('C5 lead aparece na central, marcado como clicou no WhatsApp', s==200 and lead and lead[0].get('clicou_whatsapp_em'), (s,str(D)[:200]))
ok('C6 central lista as 25 lojas', s==200 and len(D['lojas'])==25, len((D or {}).get('lojas',[])))
s,b=req('PATCH','/api/central',{'id':idc,'status':'comprou','produto':'Redmi Note 15','valor':1500},{'content-type':'application/json','authorization':'Bearer '+tok})
ok('C7 status Comprou salvo', s==200, (s,b))
s,b=req('POST','/api/central',{'email':'camboriu@teste.invalid','senha':'Teste-Camboriu-1'},{'content-type':'application/json','cf-connecting-ip':'5.5.5.7'})
t2=b.get('token'); s,D2=req('GET','/api/central',None,{'authorization':'Bearer '+t2})
ok('C8 loja Camboriú não vê lead de Joinville', s==200 and not [l for l in D2['leads'] if l['id']==idc], s)
s,b=req('GET','/api/loja-proxima?cep=123')
ok('C9 busca CEP: CEP inválido = 400', s==400, (s,b))
s,b=req('GET','/api/loja-proxima?cep=88010020')
ok('C10 busca CEP sem internet aqui: responde erro tratado (503), não quebra', s==503 and isinstance(b,dict) and b.get('erro'), (s,b))
with sync_playwright() as p:
    br=p.chromium.launch();pg=br.new_page(viewport={'width':1280,'height':900});erros=[];pg.on('pageerror',lambda e:erros.append(str(e)))
    pg.route(lambda u:not u.startswith(B),lambda r:r.abort())
    pg.goto(B+'/index.html',wait_until='load');pg.wait_for_timeout(1000)
    n=pg.eval_on_selector_all('#lojas a[href*="pre-analise.html?loja="]','a=>a.length')
    ok('P1 página principal com as 25 lojas e o filtro', n==25 and pg.locator('#edcCidade optgroup').count()==3, n)
    pg.goto(B+'/central.html');pg.fill('#email','gerente');pg.fill('#senha','Teste-Gerente-1');pg.click('#bEntrar');pg.wait_for_timeout(1500)
    ok('P2 central abre e mostra o lead de teste com a compra', 'Teste Cloudflare' in pg.inner_text('#tLeads') and 'Redmi Note 15' in pg.inner_text('#tLeads'), pg.inner_text('#tLeads')[:200])
    pg.goto(B+'/pre-analise.html?loja=caxias');pg.fill('#paNome','Teste CF');pg.type('#paTel','54999990001');pg.type('#paCpf','52998224725')
    pg.click('.pa-submit');pg.wait_for_selector('.pa-cta',timeout=20000);pg.wait_for_timeout(500)
    ok('P3 pré-análise completa no Cloudflare (Caxias -> WhatsApp da loja)', urllib.parse.urlparse(pg.get_attribute('.pa-cta','href')).path=='/5554933809596')
    ok('P4 sem erros de JavaScript', not erros, erros)
    br.close()
print(f'\nRESUMO: {sum(res)} de {len(res)} passaram')
