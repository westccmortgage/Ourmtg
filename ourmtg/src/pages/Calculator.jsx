// Affordability + refinance calculators (spec §E.4 flow 7). Pure client-side math,
// studio-styled outputs, compliance disclaimers, and an optional "check my numbers"
// lead capture that ships the scenario to GRCRM (source: affordability_calculator).
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { submitLead } from '../lib/api'
import { SMS_CONSENT_TEXT } from '../lib/leadFlows'
import { money } from '../lib/format'
import { Alert } from '../components/ui'

// Monthly payment factor per $1 of loan at `rate`% over `years`.
function payFactor(rate, years = 30) {
  const r = Number(rate) / 100 / 12
  const n = years * 12
  if (!Number.isFinite(r) || r <= 0) return 1 / n
  return r / (1 - Math.pow(1 + r, -n))
}
const num = (v) => {
  const n = Number(String(v).replace(/[$,%\s]/g, ''))
  return Number.isFinite(n) ? n : 0
}

// Rough CA taxes+insurance: ~1.25% property tax + ~0.35% insurance, yearly, on price.
const TI_MONTHLY = 0.016 / 12
const DTI = 0.43

function useAfford(income, debts, down, rate) {
  return useMemo(() => {
    const gross = num(income) / 12
    const maxHousing = gross * DTI - num(debts)
    if (gross <= 0 || maxHousing <= 0) return null
    const k = payFactor(num(rate) || 7)
    const price = (maxHousing + num(down) * k) / (k + TI_MONTHLY)
    const loan = Math.max(0, price - num(down))
    return { price, loan, payment: loan * k + price * TI_MONTHLY }
  }, [income, debts, down, rate])
}

function useRefi(balance, oldRate, newRate, costs) {
  return useMemo(() => {
    const bal = num(balance)
    if (bal <= 0 || num(oldRate) <= 0 || num(newRate) <= 0) return null
    const oldPay = bal * payFactor(num(oldRate))
    const newPay = bal * payFactor(num(newRate))
    const savings = oldPay - newPay
    const cc = num(costs) || 4000
    return { oldPay, newPay, savings, breakeven: savings > 0 ? Math.ceil(cc / savings) : null }
  }, [balance, oldRate, newRate, costs])
}

function Out({ label, value, accent }) {
  return (
    <div className="metric">
      <span className="lbl">{label}</span>
      <span className="big-num" style={accent ? { color: 'var(--st-processing)' } : undefined}>{value}</span>
    </div>
  )
}

export default function Calculator() {
  // Affordability
  const [income, setIncome] = useState('120000')
  const [debts, setDebts] = useState('600')
  const [down, setDown] = useState('60000')
  const [rate, setRate] = useState('7')
  const afford = useAfford(income, debts, down, rate)
  // Refi
  const [balance, setBalance] = useState('520000')
  const [oldRate, setOldRate] = useState('7.5')
  const [newRate, setNewRate] = useState('6.25')
  const [costs, setCosts] = useState('4000')
  const refi = useRefi(balance, oldRate, newRate, costs)
  // Lead capture
  const [contact, setContact] = useState({ name: '', email: '', phone: '', consent: false })
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const setC = (k) => (e) =>
    setContact((c) => ({ ...c, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  async function sendNumbers(e) {
    e.preventDefault()
    setError('')
    if (!contact.consent) { setError('Please agree to be contacted so we can send your review.'); return }
    setBusy(true)
    try {
      const lines = ['OurMTG · Calculator scenario']
      if (afford) lines.push(`Affordability: income $${income}/yr, debts $${debts}/mo, down $${down}, rate ${rate}% → max price ~${money(afford.price)}, payment ~${money(afford.payment)}/mo`)
      if (refi) lines.push(`Refi: balance $${balance}, ${oldRate}% → ${newRate}% → saves ~${money(refi.savings)}/mo, breakeven ${refi.breakeven ?? '—'} mo`)
      await submitLead({
        source: 'affordability_calculator',
        tags: ['OurMTG', 'Calculator'],
        name: contact.name,
        email: contact.email,
        phone: contact.phone,
        message: lines.join('\n'),
        consent: { sms: !!contact.consent, email: !!contact.consent, text: SMS_CONSENT_TEXT, capturedAt: new Date().toISOString(), userAgent: navigator.userAgent },
      })
      setSent(true)
    } catch (err) {
      setError(err?.message || 'Could not send. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ maxWidth: 560, margin: '8px auto' }}>
      <Link to="/" className="backlink">← Home</Link>
      <section className="hero" style={{ padding: '12px 0 4px' }}>
        <p className="eyebrow">calculators · estimates only</p>
        <h1>run the numbers,<br /><span className="lt">before the numbers run you.</span></h1>
        <div className="wire" aria-hidden="true" style={{ margin: '22px 0 0' }} />
      </section>

      <div className="card" style={{ marginTop: 24 }}>
        <div className="card-head"><h2>What can I afford?</h2></div>
        <div className="grid2">
          <div className="field"><label>Household income / year</label><input value={income} onChange={(e) => setIncome(e.target.value)} inputMode="numeric" /></div>
          <div className="field"><label>Monthly debts</label><input value={debts} onChange={(e) => setDebts(e.target.value)} inputMode="numeric" /></div>
        </div>
        <div className="grid2">
          <div className="field"><label>Down payment</label><input value={down} onChange={(e) => setDown(e.target.value)} inputMode="numeric" /></div>
          <div className="field"><label>Rate %</label><input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" /></div>
        </div>
        {afford ? (
          <div className="metrics" style={{ marginTop: 6 }}>
            <Out label="Max home price" value={money(afford.price)} accent />
            <Out label="Loan amount" value={money(afford.loan)} />
            <Out label="Est. payment / mo" value={money(afford.payment)} />
          </div>
        ) : <p className="hint">Enter your income to see your range.</p>}
        <p className="hint" style={{ marginTop: 14 }}>30-year term · includes rough CA taxes & insurance · 43% DTI. Estimates only — not a loan offer or approval.</p>
      </div>

      <div className="card">
        <div className="card-head"><h2>Does refinancing pay?</h2></div>
        <div className="grid2">
          <div className="field"><label>Current balance</label><input value={balance} onChange={(e) => setBalance(e.target.value)} inputMode="numeric" /></div>
          <div className="field"><label>Closing costs</label><input value={costs} onChange={(e) => setCosts(e.target.value)} inputMode="numeric" /></div>
        </div>
        <div className="grid2">
          <div className="field"><label>Current rate %</label><input value={oldRate} onChange={(e) => setOldRate(e.target.value)} inputMode="decimal" /></div>
          <div className="field"><label>New rate %</label><input value={newRate} onChange={(e) => setNewRate(e.target.value)} inputMode="decimal" /></div>
        </div>
        {refi ? (
          <div className="metrics" style={{ marginTop: 6 }}>
            <Out label="Monthly savings" value={refi.savings > 0 ? money(refi.savings) : '—'} accent={refi.savings > 0} />
            <Out label="New payment" value={money(refi.newPay)} />
            <Out label="Breakeven" value={refi.breakeven ? `${refi.breakeven} mo` : '—'} />
          </div>
        ) : <p className="hint">Enter your loan to compare.</p>}
        <p className="hint" style={{ marginTop: 14 }}>Principal & interest only, 30-year comparison. Estimates only — rates shown are examples, not offers.</p>
      </div>

      <div className="card">
        <div className="card-head"><h2>Want these numbers checked by a human?</h2></div>
        {sent ? (
          <Alert kind="ok">Got it — your scenario is with the team. We’ll come back with real options shortly.</Alert>
        ) : (
          <form onSubmit={sendNumbers}>
            <Alert kind="error">{error}</Alert>
            <div className="field"><label htmlFor="c-nm">Name</label><input id="c-nm" required value={contact.name} onChange={setC('name')} autoComplete="name" /></div>
            <div className="grid2">
              <div className="field"><label htmlFor="c-em">Email</label><input id="c-em" type="email" required value={contact.email} onChange={setC('email')} inputMode="email" /></div>
              <div className="field"><label htmlFor="c-ph">Phone</label><input id="c-ph" type="tel" value={contact.phone} onChange={setC('phone')} inputMode="tel" /></div>
            </div>
            <div className="field checkline">
              <input id="c-consent" type="checkbox" checked={contact.consent} onChange={setC('consent')} />
              <label htmlFor="c-consent">{SMS_CONSENT_TEXT}</label>
            </div>
            <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Sending…' : 'Send my scenario for review'}</button>
          </form>
        )}
      </div>
    </div>
  )
}
