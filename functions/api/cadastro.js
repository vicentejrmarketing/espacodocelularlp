// Cloudflare Pages: /api/cadastro -> mesma função usada na Vercel (api/cadastro.js)
import handler from "../../api/cadastro.js";
import { adaptar } from "../../cloudflare/adaptador.js";
export const onRequest = adaptar(handler);
