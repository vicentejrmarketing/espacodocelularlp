/* Lista única das lojas participantes da LP PAG+AGENDAMENTO.
   Este mesmo arquivo é usado pela página (window.EDC_LOJAS) e pelo servidor (require),
   para que a validação e o pop-up nunca divirjam.

   Não coloque segredos aqui: o arquivo é público.

   codigo          valor estável enviado ao CRM no campo "loja"
   nome            nome exibido no formulário
   calLink         "usuario/evento" do Cal.com dessa loja (null = agenda ainda não configurada)
   calEventTypeId  ID numérico do evento no Cal.com (preencher com o valor real; não inventar)
   fuso            fuso horário da agenda da loja
   whatsapp        número do WhatsApp do vendedor (botão "Finalize a compra com vendedor"; null = sem botão)

   ATENÇÃO: Itajaí, Navegantes e Camboriú ainda usam o mesmo evento compartilhado
   ("espacodocelular/agendamento-na-loja"). Quando cada uma tiver o próprio evento,
   troque o calLink aqui. Colombo ainda não tem evento: o pop-up fica indisponível
   para Colombo até o calLink ser preenchido. */
(function (raiz) {
  var LOJAS = {
    colombo: {
      codigo: "colombo",
      nome: "Colombo",
      calLink: null,
      calEventTypeId: null,
      fuso: "America/Sao_Paulo",
      whatsapp: null,
    },
    itajai: {
      codigo: "itajai",
      nome: "Itajaí",
      calLink: "espacodocelular/agendamento-na-loja",
      calEventTypeId: null,
      fuso: "America/Sao_Paulo",
      whatsapp: "554799481741",
    },
    navegantes: {
      codigo: "navegantes",
      nome: "Navegantes",
      calLink: "espacodocelular/agendamento-na-loja",
      calEventTypeId: null,
      fuso: "America/Sao_Paulo",
      whatsapp: "5547996439174",
    },
    camboriu: {
      codigo: "camboriu",
      nome: "Camboriú",
      calLink: "espacodocelular/agendamento-na-loja",
      calEventTypeId: null,
      fuso: "America/Sao_Paulo",
      whatsapp: "5547997641397",
    },
  };
  if (typeof module !== "undefined" && module.exports) module.exports = LOJAS;
  else raiz.EDC_LOJAS = LOJAS;
})(this);
