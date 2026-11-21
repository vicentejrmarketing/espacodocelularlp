// Cloudflare Pages: /api/clique -> mesma função usada na Vercel (api/clique.js)
import handler from "../../api/clique.js";
import { adaptar } from "../../cloudflare/adaptador.js";
export const onRequest = adaptar(handler);
