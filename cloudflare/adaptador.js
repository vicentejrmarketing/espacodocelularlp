// Faz as funções da pasta api/ (formato Vercel/Node: handler(req, res)) rodarem no Cloudflare Pages Functions.
// Requer a flag de compatibilidade "nodejs_compat" (ver wrangler.toml).
import { Buffer } from "node:buffer";

export function adaptar(handler) {
  return async function onRequest(context) {
    const { request, env } = context;
    // as funções leem process.env: copia as variáveis do projeto do Cloudflare
    globalThis.process = globalThis.process || { env: {} };
    process.env = process.env || {};
    for (const [k, v] of Object.entries(env || {})) if (typeof v === "string") process.env[k] = v;

    const url = new URL(request.url);
    const headers = {};
    request.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const ip = request.headers.get("cf-connecting-ip") || "";
    if (ip) headers["x-forwarded-for"] = ip;
    const temCorpo = !["GET", "HEAD"].includes(request.method);
    const corpo = temCorpo ? await request.text() : undefined;

    const req = {
      method: request.method,
      url: url.pathname + url.search,
      headers,
      body: corpo,
      socket: { remoteAddress: ip },
      async *[Symbol.asyncIterator]() {
        if (corpo) yield Buffer.from(corpo);
      },
    };

    return await new Promise((resolve, reject) => {
      const h = new Headers();
      let status = 200;
      let terminou = false;
      const res = {
        get statusCode() { return status; },
        set statusCode(v) { status = Number(v) || 200; },
        setHeader(k, v) { h.set(k, Array.isArray(v) ? v.join(", ") : String(v)); },
        getHeader(k) { return h.get(k); },
        end(b) {
          if (terminou) return;
          terminou = true;
          const semCorpo = status === 204 || status === 304 || request.method === "HEAD";
          resolve(new Response(semCorpo ? null : b == null ? null : b, { status, headers: h }));
        },
      };
      Promise.resolve()
        .then(() => handler(req, res))
        .then(() => { if (!terminou) res.end(); })
        .catch((e) => {
          if (terminou) return;
          console.error(JSON.stringify({ evento: "cloudflare_funcao", estado: "erro_inesperado" }));
          terminou = true;
          resolve(new Response(JSON.stringify({ ok: false, erro: "erro_interno" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
    });
  };
}
