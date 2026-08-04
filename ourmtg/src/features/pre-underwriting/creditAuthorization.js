// Credit authorization — the borrower's permission to pull their credit.
//
// This is not a document and it is not a preference. Under the FCRA a consumer report may only
// be obtained for a permissible purpose, and for a mortgage that purpose rests on the consumer
// having initiated the transaction and authorized the pull. What is stored here is the evidence
// of that authorization: who gave it, exactly what text they were shown, when they were shown
// it, and when they accepted.
//
// ── Why it is modelled like the 1003 attestation, not like a checkbox ───────
// A checkbox proves nothing a year later. What has to survive is: THIS person saw THIS wording
// at THIS moment and accepted it. So the version of the text is recorded with the acceptance,
// the client must echo back the version it displayed, and a mismatch is refused rather than
// quietly accepted — the same rule the application attestation uses, for the same reason.
//
// ── What it does NOT authorize ─────────────────────────────────────────────
// One pull, for this loan, by this lender. Not a standing permission, not a soft-pull marketing
// list, not sharing with anyone the borrower has not been told about. Anything broader would
// have to be its own disclosure with its own acceptance, and this module has no way to express
// it — deliberately.

export const CREDIT_AUTH_VERSION = '2026.08.credit.1'

// Draft wording. Reviewed: false — like the 1003 attestation, this is a placeholder that a
// compliance review has to replace before a real borrower reads it. It is written to be honest
// rather than to be final.
export const CREDIT_AUTHORIZATION = Object.freeze({
  version: CREDIT_AUTH_VERSION,
  reviewed: false,
  title: {
    en: 'Permission to check your credit',
    es: 'Autorización para consultar su crédito',
    ru: 'Разрешение на проверку кредитной истории',
  },
  body: {
    en: [
      'To see which loan programs you can use, we need to look at your credit report from Equifax, Experian, and TransUnion.',
      'This is a hard inquiry, and it may lower your score by a few points for a short time. Mortgage inquiries made within a 45-day window are counted as one, so shopping with more than one lender does not multiply the effect.',
      'You are giving permission for one credit pull for this loan, by West Coast Capital Mortgage. We do not sell your information, and this does not permit anyone else to check your credit.',
      'Checking your credit is not an application decision. It does not approve, pre-approve, or commit anyone to lend.',
    ],
    es: [
      'Para ver qué programas de préstamo puede usar, necesitamos consultar su informe de crédito de Equifax, Experian y TransUnion.',
      'Es una consulta formal y puede bajar su puntaje unos pocos puntos por poco tiempo. Las consultas hipotecarias hechas dentro de 45 días cuentan como una sola.',
      'Usted autoriza una sola consulta de crédito para este préstamo, por West Coast Capital Mortgage. No vendemos su información y esto no autoriza a nadie más a consultar su crédito.',
      'Consultar su crédito no es una decisión sobre su solicitud. No aprueba, no preaprueba y no compromete a nadie a prestar.',
    ],
    ru: [
      'Чтобы понять, какие кредитные программы вам доступны, нам нужно посмотреть вашу кредитную историю в Equifax, Experian и TransUnion.',
      'Это официальный запрос, он может ненадолго снизить ваш балл на несколько пунктов. Ипотечные запросы в течение 45 дней считаются как один.',
      'Вы даёте разрешение на одну проверку кредита по этому займу компанией West Coast Capital Mortgage. Мы не продаём ваши данные, и это не разрешает проверку кредита никому другому.',
      'Проверка кредита не является решением по заявке. Она не одобряет и не обязывает никого выдать кредит.',
    ],
  },
  accept: {
    en: 'I authorize this credit check',
    es: 'Autorizo esta consulta de crédito',
    ru: 'Я разрешаю эту проверку кредита',
  },
})

// A pull is good for one loan and does not last forever. 120 days matches the outside life of
// the report itself: authorizing a pull is not authorizing pulls indefinitely.
export const AUTHORIZATION_VALID_DAYS = 120

const DAY = 86_400_000

/**
 * Is there a live authorization covering this party?
 *
 * @param {Array<object>} authorizations  stored rows, any order
 * @param {{partyIndex?: number, asOf?: number}} [opts]
 * @returns {{ok: boolean, reason: string|null, authorization: object|null, expiresAt: number|null}}
 */
export function creditPullAllowed(authorizations, opts = {}) {
  const asOf = opts.asOf ?? Date.now()
  const partyIndex = opts.partyIndex ?? 0

  const mine = (authorizations || [])
    .filter(Boolean)
    .filter((a) => (a.partyIndex ?? a.party_index ?? 0) === partyIndex)
    .filter((a) => !(a.revokedAt || a.revoked_at))

  if (mine.length === 0) {
    return { ok: false, reason: 'not_authorized', authorization: null, expiresAt: null }
  }

  // Newest wins: a borrower who re-authorized after an expiry has authorized.
  const newest = mine
    .map((a) => ({ row: a, at: Date.parse(String(a.acceptedAt ?? a.accepted_at ?? '')) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => b.at - a.at)[0]

  if (!newest) return { ok: false, reason: 'not_authorized', authorization: null, expiresAt: null }

  const expiresAt = newest.at + AUTHORIZATION_VALID_DAYS * DAY
  if (asOf > expiresAt) {
    // Not an error and not the borrower's fault — files take time. It is a re-ask, and saying
    // so plainly is what stops someone pulling credit on a stale permission.
    return { ok: false, reason: 'expired', authorization: newest.row, expiresAt }
  }
  return { ok: true, reason: null, authorization: newest.row, expiresAt }
}

/**
 * Validate an acceptance before it is stored. Untrusted input: everything here arrives from a
 * browser, including the claim about which text was displayed.
 */
export function validateAcceptance(body = {}, opts = {}) {
  if (body.accepted !== true) return { ok: false, error: 'not_accepted' }
  // The client echoes the version it rendered. A mismatch means the page was open across a
  // wording change, and accepting it would record consent to text nobody saw.
  if (body.documentVersion !== CREDIT_AUTH_VERSION) return { ok: false, error: 'stale_version' }

  const presented = Date.parse(String(body.presentedAt ?? ''))
  if (!Number.isFinite(presented)) return { ok: false, error: 'invalid_presented_at' }

  const asOf = opts.asOf ?? Date.now()
  // A presentation timestamp in the future is a clock problem or a forged one; either way it is
  // not evidence of anything.
  if (presented > asOf + 60_000) return { ok: false, error: 'invalid_presented_at' }

  const partyIndex = body.partyIndex === 1 ? 1 : (body.partyIndex === 0 ? 0 : null)
  if (partyIndex === null) return { ok: false, error: 'invalid_party' }

  return {
    ok: true,
    value: {
      partyIndex,
      documentVersion: CREDIT_AUTH_VERSION,
      presentedAt: new Date(presented).toISOString(),
      acceptedAt: new Date(asOf).toISOString(),
    },
  }
}

/**
 * The finding a file gets when credit is needed and nobody has permission to get it.
 *
 * Phrased as an action for the loan team, because it is one: this is not a borrower failing to
 * send a document, it is a step the team has not taken yet.
 */
export function authorizationGap(state = {}) {
  const check = creditPullAllowed(state.authorizations, { asOf: state.asOf })
  if (check.ok) return null
  return {
    rule: 'credit_authorization',
    category: 'identity',
    severity: 'high',
    reason: check.reason,
    explanation: check.reason === 'expired'
      ? 'The credit authorization on file is more than 120 days old, so it no longer covers a pull. Ask the borrower to authorize again before ordering credit.'
      : 'No credit authorization is on file, so credit cannot be pulled for this borrower. Send them the authorization; it takes one tap and is required before any report is ordered.',
    owner: 'loan_team',
  }
}
