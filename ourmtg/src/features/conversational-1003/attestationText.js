// Conversational 1003 — borrower attestation text (§6.J, §26).
//
// COMPLIANCE STATUS: DRAFT — NOT COUNSEL-REVIEWED.
// This wording is a placeholder written to be honest and non-misleading, not a reviewed legal
// disclosure. It is deliberately narrow: it attests to the accuracy of the information the
// borrower supplied and NOTHING else. It is not an e-signature, not a credit authorization,
// not an intent-to-proceed, and not a consent to pull credit — each of those is a separate,
// separately-versioned document that this file does not attempt to cover.
//
// The version string is stored with every acceptance, so an accepted attestation can always be
// reproduced verbatim. Changing the text REQUIRES bumping the version — an unversioned edit
// would silently rewrite what past borrowers agreed to.

export const ATTESTATION_VERSION = '2026.07.attest.draft.1'

// English is the controlling text. Spanish and Russian are shown as a courtesy translation
// alongside it — they are NOT reviewed translations and must not be presented as controlling
// until counsel approves them (§17: the model may never freely translate controlling text).
export const ATTESTATION = Object.freeze({
  version: ATTESTATION_VERSION,
  controllingLocale: 'en',
  reviewed: false,
  title: {
    en: 'Before you submit',
    es: 'Antes de enviar',
    ru: 'Перед отправкой',
  },
  body: {
    en: [
      'I have reviewed the information shown above.',
      'To the best of my knowledge, it is complete and accurate. Where I marked something as an estimate, I understand it is an estimate and may need to be verified with documents.',
      'I understand that submitting this information is not an application decision. It does not mean my loan is approved, pre-approved, verified, underwritten, or submitted to any lender, and it is not a commitment to lend.',
      'I understand my loan team will review this information and may ask me for documents or clarification.',
    ],
    es: [
      'He revisado la información que aparece arriba.',
      'Según mi leal saber y entender, está completa y es exacta. Cuando marqué algo como estimado, entiendo que es una estimación y puede requerir verificación con documentos.',
      'Entiendo que enviar esta información no es una decisión sobre mi solicitud. No significa que mi préstamo esté aprobado, preaprobado, verificado, evaluado ni enviado a ningún prestamista, y no es un compromiso de préstamo.',
      'Entiendo que mi equipo revisará esta información y podría pedirme documentos o aclaraciones.',
    ],
    ru: [
      'Я ознакомился с указанной выше информацией.',
      'Насколько мне известно, она полная и точная. Там, где я отметил значение как приблизительное, я понимаю, что это оценка и может потребоваться подтверждение документами.',
      'Я понимаю, что отправка этой информации не является решением по заявке. Это не означает, что кредит одобрен, предварительно одобрен, проверен, рассмотрен андеррайтингом или направлен кредитору, и не является обязательством предоставить кредит.',
      'Я понимаю, что кредитная команда проверит информацию и может запросить документы или уточнения.',
    ],
  },
  acceptLabel: {
    en: 'I confirm the information above is complete and accurate',
    es: 'Confirmo que la información anterior es completa y exacta',
    ru: 'Подтверждаю, что информация выше полная и точная',
  },
  // Rendered next to the accept control so the boundary is on-screen, not buried in a doc.
  notAnEsignature: {
    en: 'This confirmation is not an electronic signature. Any documents that require your signature will be sent to you separately.',
    es: 'Esta confirmación no es una firma electrónica. Los documentos que requieran su firma se le enviarán por separado.',
    ru: 'Это подтверждение не является электронной подписью. Документы, требующие подписи, будут направлены отдельно.',
  },
})

// Items a compliance reviewer must sign off before this ships to a real borrower.
export const ATTESTATION_REVIEW_ITEMS = Object.freeze([
  'Confirm the attestation wording is acceptable to counsel and to the lender/investor.',
  'Confirm Spanish and Russian translations before presenting them as anything but a courtesy.',
  'Decide whether an intent-to-proceed and a credit-pull authorization are required at this step, and if so, model them as separate versioned documents.',
  'Confirm the IP address and user-agent capture matches the approved privacy policy.',
  'Confirm retention of application_snapshot satisfies the record-retention schedule.',
])
