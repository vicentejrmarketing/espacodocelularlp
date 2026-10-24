// Armazenamento durável das submissões (chave-valor com API REST no formato Redis:
// Vercel KV / Upstash). Só é usado se as variáveis abaixo existirem; não cria nem contrata nada.
//
//   KV_REST_API_URL + KV_REST_API_TOKEN                 (nomes do Vercel KV)
//   ou UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (nomes do Upstash)
//
// Sem essas variáveis, getStore() devolve null e a função funciona no modo sem persistência.

function configuracao(env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

function getStore(env) {
  const cfg = configuracao(env || process.env);
  if (!cfg) return null;

  async function cmd(args) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(cfg.url, {
        method: "POST",
        headers: { Authorization: "Bearer " + cfg.token, "Content-Type": "application/json" },
        body: JSON.stringify(args.map(String)),
        signal: ctrl.signal,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error("kv_" + r.status);
      return j.result;
    } finally {
      clearTimeout(t);
    }
  }

  // Vários comandos numa única requisição (endpoint /pipeline da API REST). Devolve os resultados em ordem.
  async function pipeline(cmds) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(cfg.url + "/pipeline", {
        method: "POST",
        headers: { Authorization: "Bearer " + cfg.token, "Content-Type": "application/json" },
        body: JSON.stringify(cmds.map((c) => c.map(String))),
        signal: ctrl.signal,
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !Array.isArray(j)) throw new Error("kv_" + r.status);
      return j.map((x) => {
        if (x && x.error) throw new Error("kv_cmd");
        return x ? x.result : null;
      });
    } finally {
      clearTimeout(t);
    }
  }

  return {
    pipeline,
    async get(k) {
      const v = await cmd(["GET", k]);
      return v == null ? null : JSON.parse(v);
    },
    async set(k, v, ttlSeg) {
      const a = ["SET", k, JSON.stringify(v)];
      if (ttlSeg) a.push("EX", ttlSeg);
      await cmd(a);
    },
    // Cria somente se não existir (evita duas submissões disputando o mesmo registro)
    async setNovo(k, v, ttlSeg) {
      const a = ["SET", k, JSON.stringify(v), "NX"];
      if (ttlSeg) a.push("EX", ttlSeg);
      return (await cmd(a)) === "OK";
    },
    // Trava com dono: só quem criou a trava consegue liberá-la (liberação atômica via script).
    async travar(k, ttlSeg) {
      const dono = require("crypto").randomUUID();
      return (await cmd(["SET", k, dono, "NX", "EX", ttlSeg])) === "OK" ? dono : null;
    },
    async destravar(k, dono) {
      await cmd(["EVAL", "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", 1, k, dono]);
    },
    async agendar(fila, membro, quando) {
      await cmd(["ZADD", fila, quando, membro]);
    },
    async desagendar(fila, membro) {
      await cmd(["ZREM", fila, membro]);
    },
    async listar(fila, limite) {
      return (await cmd(["ZRANGE", fila, 0, limite - 1])) || [];
    },
    async listarComPontuacao(fila, limite) {
      const r = (await cmd(["ZRANGE", fila, 0, limite - 1, "WITHSCORES"])) || [];
      const out = [];
      for (let i = 0; i < r.length; i += 2) out.push([r[i], Number(r[i + 1])]);
      return out;
    },
    // Script Lua executado de forma atômica pelo Redis (EVAL). Precisa ser comprovado no armazenamento real.
    async script(lua, chaves, args) {
      return await cmd(["EVAL", lua, chaves.length, ...chaves, ...args]);
    },
    async vencidos(fila, agora, limite) {
      return (await cmd(["ZRANGEBYSCORE", fila, "-inf", agora, "LIMIT", 0, limite])) || [];
    },
  };
}

module.exports = { getStore };
