// Cloudflare Pages: /api/loja-proxima -> mesma função usada na Vercel (api/loja-proxima.js)
import handler from "../../api/loja-proxima.js";
import { adaptar } from "../../cloudflare/adaptador.js";
export const onRequest = adaptar(handler);
