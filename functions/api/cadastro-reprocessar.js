// Cloudflare Pages: /api/cadastro-reprocessar -> mesma função usada na Vercel (api/cadastro-reprocessar.js)
import handler from "../../api/cadastro-reprocessar.js";
import { adaptar } from "../../cloudflare/adaptador.js";
export const onRequest = adaptar(handler);
