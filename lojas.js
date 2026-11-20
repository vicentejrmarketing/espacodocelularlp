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
   vitrine         true = a loja tem card na página principal e entra na busca por CEP / cidade
   cidade, uf      cidade da loja (busca por CEP: quem mora nessa cidade vai para esta loja)
   lat, lon        posição aproximada da loja (centro), usada para achar a loja mais próxima pelo CEP

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
      vitrine: false,
      cidade: "Colombo",
      uf: "PR",
      lat: -25.2917,
      lon: -49.2242,
    },
    itajai: {
      codigo: "itajai",
      nome: "Itajaí",
      calLink: "espacodocelular/agendamento-na-loja",
      calEventTypeId: null,
      fuso: "America/Sao_Paulo",
      whatsapp: "5547933868196",
      vitrine: true,
      cidade: "Itajaí",
      uf: "SC",
      lat: -26.9087,
      lon: -48.6627,
    },
    navegantes: {
      codigo: "navegantes",
      nome: "Navegantes",
      calLink: "espacodocelular/agendamento-na-loja",
      calEventTypeId: null,
      fuso: "America/Sao_Paulo",
      whatsapp: "5547996439174",
      vitrine: true,
      cidade: "Navegantes",
      uf: "SC",
      lat: -26.8988,
      lon: -48.6542,
    },
    camboriu: {
      codigo: "camboriu",
      nome: "Camboriú",
      calLink: "espacodocelular/agendamento-na-loja",
      calEventTypeId: null,
      fuso: "America/Sao_Paulo",
      whatsapp: "5547997641397",
      vitrine: true,
      cidade: "Camboriú",
      uf: "SC",
      lat: -27.0249,
      lon: -48.6546,
    },
    florianopolis: {
      codigo: "florianopolis",
      nome: "Florianópolis",
      calLink: null,
      calEventTypeId: null,
      fuso: "America/Sao_Paulo",
      whatsapp: "5548996270809",
      vitrine: true,
      cidade: "Florianópolis",
      uf: "SC",
      lat: -27.5967,
      lon: -48.5521,
    },
  };
  if (typeof module !== "undefined" && module.exports) module.exports = LOJAS;
  else raiz.EDC_LOJAS = LOJAS;
})(this);
