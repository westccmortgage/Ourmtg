import test from 'node:test'
import assert from 'node:assert/strict'
import {
  interpretGoogleAddressValidation, propertyAddressFromState, validatePropertyAddress,
} from '../netlify/functions/_lib/addressValidation.mjs'

const input = { street: '122275 Sky Ln', city: 'Los Angeles', state: 'CA', postalCode: '90049' }
const result = ({ street = input.street, granularity = 'PREMISE', dpv = 'Y', ...verdict } = {}) => ({
  responseId: 'response-1',
  result: {
    verdict: { addressComplete: true, validationGranularity: granularity, ...verdict },
    address: {
      formattedAddress: `${street}, Los Angeles, CA 90049, USA`,
      postalAddress: {
        addressLines: [street], locality: 'Los Angeles', administrativeArea: 'CA', postalCode: '90049',
      },
    },
    uspsData: { dpvConfirmation: dpv },
  },
})

test('an extra house-number digit becomes a suggestion, never a silent correction', () => {
  const out = interpretGoogleAddressValidation(
    result({ street: '12275 Sky Ln', hasReplacedComponents: true }), input,
  )
  assert.equal(out.status, 'suggestion')
  assert.equal(out.suggested.street, '12275 Sky Ln')
  assert.equal(out.responseId, 'response-1')
})

test('a premise-level exact USPS match is verified', () => {
  const out = interpretGoogleAddressValidation(result(), input)
  assert.equal(out.status, 'verified')
  assert.equal(out.uspsConfirmed, true)
})

test('a route-level result is not represented as a verified property', () => {
  const out = interpretGoogleAddressValidation(result({ granularity: 'ROUTE', dpv: '' }), input)
  assert.equal(out.status, 'fix')
  assert.equal(out.reason, 'premise_not_verified')
})

test('missing credentials and incomplete addresses fail closed without a provider call', async () => {
  assert.deepEqual(await validatePropertyAddress(input, { apiKey: '' }), {
    status: 'unavailable', reason: 'not_configured',
  })
  assert.deepEqual(await validatePropertyAddress({ street: '12275 Sky Ln' }, { apiKey: 'x' }), {
    status: 'incomplete', reason: 'missing_components',
  })
})

test('the validator reads the whole property address from reducer state', () => {
  const fields = Object.fromEntries(Object.entries({
    'loan.propertyStreet': '12275 Sky Ln',
    'loan.propertyCity': 'Los Angeles',
    'loan.propertyState': 'CA',
    'loan.propertyPostalCode': '90049',
  }).map(([path, normalized_value]) => [path, { normalized_value }]))
  assert.deepEqual(propertyAddressFromState({ fields }), {
    street: '12275 Sky Ln', city: 'Los Angeles', state: 'CA', postalCode: '90049',
  })
})
