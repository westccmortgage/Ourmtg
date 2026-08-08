// Server-only property-address verification through Google Address Validation.
//
// A house number that merely "looks plausible" is not evidence that the property exists. This
// adapter turns Google's component verdict into three deliberately small product outcomes:
// verified, suggestion (the human must accept it), or fix (nothing is guessed).

const ENDPOINT = 'https://addressvalidation.googleapis.com/v1:validateAddress'
const PREMISE_GRANULARITY = new Set(['PREMISE', 'SUB_PREMISE'])

const clean = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const comparable = (value) => clean(value).toUpperCase().replace(/[^A-Z0-9]/g, '')

export function propertyAddressFromState(state) {
  const value = (path) => state?.fields?.[path]?.normalized_value ?? null
  const address = {
    street: value('loan.propertyStreet'),
    city: value('loan.propertyCity'),
    state: value('loan.propertyState'),
    postalCode: value('loan.propertyPostalCode'),
  }
  return Object.values(address).every((v) => clean(v)) ? address : null
}

export async function validatePropertyAddress(address, {
  apiKey = process.env.GOOGLE_ADDRESS_VALIDATION_API_KEY || '',
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) return { status: 'unavailable', reason: 'not_configured' }
  if (!address || !clean(address.street) || !clean(address.city)
    || !clean(address.state) || !clean(address.postalCode)) {
    return { status: 'incomplete', reason: 'missing_components' }
  }

  let response
  try {
    response = await fetchImpl(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        address: {
          regionCode: 'US',
          addressLines: [clean(address.street, 300)],
          locality: clean(address.city, 120),
          administrativeArea: clean(address.state, 40),
          postalCode: clean(address.postalCode, 20),
        },
        enableUspsCass: true,
      }),
    })
  } catch {
    return { status: 'unavailable', reason: 'provider_unreachable' }
  }
  if (!response?.ok) return { status: 'unavailable', reason: 'provider_error' }

  let payload
  try { payload = await response.json() } catch {
    return { status: 'unavailable', reason: 'invalid_provider_response' }
  }
  return interpretGoogleAddressValidation(payload, address)
}

export function interpretGoogleAddressValidation(payload, input) {
  const result = payload?.result || null
  const verdict = result?.verdict || {}
  const postal = result?.address?.postalAddress || {}
  const usps = result?.uspsData || {}
  const suggested = {
    street: clean(postal.addressLines?.join(' '), 300),
    city: clean(postal.locality, 120),
    state: clean(postal.administrativeArea, 40),
    postalCode: clean(postal.postalCode, 20),
  }
  const completeSuggestion = Object.values(suggested).every(Boolean)
  const premise = PREMISE_GRANULARITY.has(verdict.validationGranularity)
  const deliverable = usps.dpvConfirmation === 'Y'
    || (verdict.addressComplete === true && premise)

  if (!deliverable || !completeSuggestion || verdict.hasUnconfirmedComponents === true) {
    return {
      status: 'fix',
      reason: !premise ? 'premise_not_verified' : 'address_components_unconfirmed',
      missing: Array.isArray(result?.address?.missingComponentTypes)
        ? result.address.missingComponentTypes.slice(0, 10) : [],
    }
  }

  const same = ['street', 'city', 'state', 'postalCode']
    .every((key) => comparable(input?.[key]) === comparable(suggested[key]))
  const changed = verdict.hasReplacedComponents === true
    || verdict.hasInferredComponents === true
    || verdict.hasSpellCorrectedComponents === true
    || !same

  return {
    status: changed ? 'suggestion' : 'verified',
    reason: changed ? 'provider_standardized_address' : null,
    formattedAddress: clean(result?.address?.formattedAddress, 400)
      || `${suggested.street}, ${suggested.city}, ${suggested.state} ${suggested.postalCode}`,
    suggested,
    responseId: clean(payload?.responseId, 200) || null,
    uspsConfirmed: usps.dpvConfirmation === 'Y',
  }
}

