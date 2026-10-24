// Acessos da central de leads (e-mail ou usuário -> loja), lidos da variável CENTRAL_ACESSOS da Vercel.
// Formato (JSON): {"email@loja.com":{"acesso":"itajai","senha":"scrypt$<sal>$<resumo>"}, "gerente":{"acesso":"geral",...}}
// A senha nunca fica escrita: só o resumo scrypt dela. Nada disso fica no código nem no GitHub.
// Para gerar o resumo de uma senha nova:  node -e 'const c=require("crypto"),s=c.randomBytes(16).toString("hex");console.log("scrypt$"+s+"$"+c.scryptSync(process.argv[1],s,32).toString("hex"))' NovaSenha
module.exports = function acessos() {
  try {
    const bruto = JSON.parse(process.env.CENTRAL_ACESSOS || "{}");
    const out = {};
    for (const [k, v] of Object.entries(bruto || {})) {
      if (v && typeof v.acesso === "string" && typeof v.senha === "string") out[String(k).trim().toLowerCase()] = v;
    }
    return out;
  } catch (e) {
    console.error(JSON.stringify({ evento: "central", estado: "CENTRAL_ACESSOS_invalido", nivel: "alerta" }));
    return {};
  }
};
