// Cloudflare Pages: /api/central -> mesma função usada na Vercel (api/central.js)
import handler from "../../api/central.js";
import { adaptar } from "../../cloudflare/adaptador.js";
export const onRequest = adaptar(handler);
