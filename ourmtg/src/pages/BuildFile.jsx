// «Моё Дело №» — the interactive file builder (/plan). The conversion inversion:
// the visitor gets their full personalized answer BEFORE any contact is asked —
// seven tap-through questions (no email, no phone) assemble a DRAFT loan file on
// screen: route to keys, price range, matched programs, a live rent clock, and a
// draft pre-approval letter with their name on it. Contact is asked once, at the
// end, to ACTIVATE the file they already own. Endowment does the selling.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { submitLead } from '../lib/api'
import { SMS_CONSENT_TEXT } from '../lib/leadFlows'
import { money } from '../lib/format'
import { Alert } from '../components/ui'

// ── the seven taps ────────────────────────────────────────────────────────────
const QUESTIONS = [
  { key: 'name', type: 'text', q: 'First, what should we call you?', ph: 'First name', skip: true },
  { key: 'goal', q: 'What are we doing?', opts: [
    ['first', 'Buying my first home'],
    ['next', 'Buying my next home'],
    ['refi', 'Refinancing my rate'],
    ['cash', 'Unlocking cash from my equity'],
    ['invest', 'Buying an investment property'],
  ]},
  { key: 'when', q: 'When do you want the keys?', opts: [
    ['asap', 'As soon as possible'],
    ['3mo', 'In 1–3 months'],
    ['6mo', 'In 3–6 months'],
    ['12mo', 'In 6–12 months'],
    ['look', 'Just exploring — no pressure'],
  ]},
  { key: 'income', q: 'How do you earn?', opts: [
    ['w2', 'W-2 employee'],
    ['self', 'Self-employed / business owner'],
    ['mix', 'Mix of W-2 and 1099'],
    ['mil', 'Military / veteran'],
    ['ret', 'Retired / other'],
  ]},
  { key: 'target', q: 'What price are you aiming for?', opts: [
    ['500', 'Under $500K'],
    ['750', '$500K – $750K'],
    ['1000', '$750K – $1M'],
    ['1500', '$1M – $1.5M'],
    ['2000', '$1.5M – $2M'],
    ['3000', '$2M and up'],
    ['none', 'No target yet — show me what works'],
  ]},
  { key: 'down', q: 'Down payment you plan to bring?', opts: [
    ['none', 'Almost nothing — I need help with this'],
    ['3', 'Around 3–5%'],
    ['10', '5–10%'],
    ['20', '10–20%'],
    ['20p', '20% or more'],
  ]},
  { key: 'credit', q: 'How does your credit feel?', opts: [
    ['a', 'Excellent (740+)'],
    ['b', 'Good (680–739)'],
    ['c', 'Fair (620–679)'],
    ['d', 'Rebuilding'],
    ['u', 'Honestly, no idea'],
  ]},
  // Last and OPTIONAL — rent feeds ONLY the motivational clock, never capacity.
  { key: 'housing', type: 'money', q: 'Renting right now? Your monthly rent (optional)', chips: [1800, 2500, 3200, 4000, 5000], skip: true },
]

const OPT_LABEL = {}
for (const q of QUESTIONS) for (const [v, l] of q.opts || []) OPT_LABEL[`${q.key}:${v}`] = l

// ── file math (honest heuristics, clearly labeled estimates) ──────────────────
function payFactor(rate = 7, years = 30) {
  const r = rate / 100 / 12, n = years * 12
  return r / (1 - Math.pow(1 + r, -n))
}
const BASE_RATE = 7 // today's typical 30-yr par used as the anchor; shown, never hidden
const DOWN_PCT = { none: 0.035, 3: 0.04, 10: 0.075, 20: 0.15, '20p': 0.25 }
const TARGET_VAL = { 500: 500000, 750: 750000, 1000: 1000000, 1500: 1500000, 2000: 2000000, 3000: 3000000 }
const TI_MONTHLY = 0.016 / 12 // rough CA taxes + insurance, per month, on price

function buildFile(a) {
  const buying = ['first', 'next', 'invest'].includes(a.goal)
  const rent = Number(a.housing) || 0
  const target = TARGET_VAL[a.target] || null

  // The buyer's own math, nothing else: THEIR target + THEIR down payment → the
  // monthly. Current rent is deliberately NOT a capacity signal (people save, move
  // cities, live small while aiming big) — it feeds only the motivational clock.
  let monthly = null, downAmt = null, downPct = null
  if (buying && target) {
    downPct = DOWN_PCT[a.down] ?? 0.05
    downAmt = target * downPct
    const loan = target - downAmt
    monthly = loan * payFactor(7) + target * TI_MONTHLY
  }
  // Draft letter prints the AMBITION — their target.
  const letterMax = buying ? target : null

  // Months to keys.
  const base = { asap: 2, '3mo': 3, '6mo': 6, '12mo': 10, look: 12 }[a.when] ?? 6
  let months = base
  if (buying && a.down === 'none') months += 2
  if (a.credit === 'd') months += 1

  // Program matches (max 3, each with a why).
  const programs = []
  if (a.income === 'mil') programs.push(['VA — $0 down', 'Your service earned the zero-down loan with no monthly MI.'])
  if (a.income === 'self' || a.income === 'mix') programs.push(['Bank-statement program', 'We qualify you on real cash flow — no tax-return gymnastics.'])
  if (buying && (a.down === 'none' || a.down === '3')) {
    programs.push(['FHA — 3.5% down', 'Friendlier credit rules, small down payment.'])
    if (a.down === 'none') programs.push(['CalHFA down-payment help', 'California programs can cover most of your down payment.'])
  }
  if (['c', 'd', 'u'].includes(a.credit)) {
    programs.push(['Credit reality check — no surprises', 'Soft check first (no score damage). If you’re 690 where you expected 740, we build a 60–90 day fix plan — that forgotten store card usually explains it.'])
  }
  if (a.goal === 'refi') programs.push(['Rate-term refinance', 'We price your exact payoff and tell you honestly if it pays.'])
  if (a.goal === 'cash') programs.push(['Cash-out / HELOC', 'Equity into cash — priced both ways so you pick the cheaper one.'])
  if ((letterMax || 0) > 1100000) programs.push(['Jumbo track', 'Above county limits — we pre-package reserves and ratios early.'])
  if (programs.length === 0) programs.push(['Conventional — best pricing', 'Strong profile: your job is choosing the house, not the loan.'])

  // The route (a real sequence — numbering carries meaning).
  const steps = buying
    ? [
        ['Activate this file', 'Today — a human reviews your answers, no credit pull yet.'],
        ['Turn the draft into a real pre-approval', '~24 hours — the letter sellers actually respect.'],
        ['Tour with the letter in hand', 'Your pace — offers with proof behind them.'],
        ['Under contract → the 7 stages', '~21–30 days — you watch every step live in this portal.'],
      ]
    : [
        ['Activate this file', 'Today — a human reviews your answers, no credit pull yet.'],
        ['Same-day payoff & savings math', 'Real numbers on your actual loan, not averages.'],
        ['Lock only when it pays', 'We watch the market so you don’t have to.'],
        ['Close in ~3 weeks', 'Tracked live in this portal, stage by stage.'],
      ]

  return { buying, rent, target, monthly, downAmt, downPct, letterMax, months, programs: programs.slice(0, 3), steps }
}

// ── live rent clock ───────────────────────────────────────────────────────────
function RentClock({ rent }) {
  const start = useRef(Date.now())
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(t)
  }, [])
  const perSec = (rent * 12) / (365.25 * 86400)
  const spent = ((now - start.current) / 1000) * perSec
  return (
    <div className="card">
      <div className="card-head"><h2>Meanwhile, your rent</h2></div>
      <p className="mb0 muted" style={{ fontSize: 13.5 }}>Since you opened this file, renting has cost you</p>
      <div className="big-num" style={{ color: 'var(--stamp)', fontSize: 44, margin: '6px 0 10px' }}>
        ${spent.toFixed(2)}
      </div>
      <div className="metrics">
        <div className="metric"><span className="lbl">This year</span><span className="big-num" style={{ fontSize: 22 }}>{money(rent * 12)}</span></div>
        <div className="metric"><span className="lbl">Of it into YOUR equity</span><span className="big-num" style={{ fontSize: 22 }}>$0.00</span></div>
      </div>
      <p className="hint" style={{ marginTop: 12 }}>Every one of those dollars built your landlord’s equity. In your own home, part of every payment comes back to YOU.</p>
    </div>
  )
}

// ── the page ──────────────────────────────────────────────────────────────────
export default function BuildFile() {
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState({})
  const [textVal, setTextVal] = useState('')
  const [fileNo] = useState(() => 'DRAFT-' + Math.random().toString(16).slice(2, 6).toUpperCase())
  // activation
  const [contact, setContact] = useState({ email: '', phone: '', consent: false })
  const [activated, setActivated] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // plan-card rate explorer (the payment is honest about its rate — and adjustable)
  const [rateSel, setRateSel] = useState(BASE_RATE)
  // rate alarm
  const [alarmRate, setAlarmRate] = useState(6.25)
  const [alarmEmail, setAlarmEmail] = useState('')
  const [alarmSet, setAlarmSet] = useState(false)

  const total = QUESTIONS.length
  const doneAsking = step >= total
  const file = useMemo(() => (doneAsking ? buildFile(answers) : null), [doneAsking, answers])

  function answer(key, value) {
    setAnswers((a) => ({ ...a, [key]: value }))
    setTextVal('')
    setStep((s) => s + 1)
    window.scrollTo({ top: 0 })
  }

  async function activate(e) {
    e.preventDefault()
    setError('')
    if (!contact.consent) { setError('Please agree to be contacted so we can activate your file.'); return }
    setBusy(true)
    try {
      const lines = [`OurMTG · File builder ${fileNo}`]
      for (const q of QUESTIONS) {
        const v = answers[q.key]
        if (v == null || v === '') continue
        lines.push(`${q.key}: ${OPT_LABEL[`${q.key}:${v}`] || v}`)
      }
      if (file?.target) {
        const loan = file.target - file.downAmt
        const mAt = loan * payFactor(rateSel) + file.target * TI_MONTHLY
        lines.push(`TARGET PRICE: ${money(file.target)} · down ~${money(file.downAmt)} (${Math.round((file.downPct || 0) * 100)}%) · est monthly ~${money(mAt)} at ${rateSel.toFixed(3)}%`)
        if (rateSel < BASE_RATE) lines.push(`Explored a buydown to ${rateSel.toFixed(3)}% (~${(((BASE_RATE - rateSel) / 0.25)).toFixed(1)} pts) — price it for real`)
      }
      lines.push(`Programs: ${file.programs.map(([p]) => p).join('; ')}`)
      lines.push(`Route: ~${file.months} months to keys`)
      await submitLead({
        source: 'file_builder',
        tags: ['OurMTG', 'File builder'],
        firstName: answers.name || '',
        name: answers.name || '',
        email: contact.email,
        phone: contact.phone,
        message: lines.join('\n'),
        consent: { sms: true, email: true, text: SMS_CONSENT_TEXT, capturedAt: new Date().toISOString(), userAgent: navigator.userAgent },
      })
      setActivated(true)
      setAlarmEmail((v) => v || contact.email)
    } catch (err) {
      setError(err?.message || 'Could not activate. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function setAlarm(e) {
    e.preventDefault()
    try {
      await submitLead({
        source: 'rate_watch',
        tags: ['OurMTG', 'Rate watch'],
        firstName: answers.name || '',
        name: answers.name || '',
        email: alarmEmail,
        message: `OurMTG · Rate alarm ${fileNo}\nCall me when rates reach: ${alarmRate.toFixed(3)}%`,
      })
      setAlarmSet(true)
    } catch { /* quiet — alarm is a bonus, never an error wall */ setAlarmSet(true) }
  }

  // ── question screens ────────────────────────────────────────────────────────
  if (!doneAsking) {
    const q = QUESTIONS[step]
    return (
      <div style={{ maxWidth: 480, margin: '8px auto' }}>
        <Link to="/" className="backlink">← Home</Link>
        <p className="fileno">Assembling file № {fileNo} · question {step + 1} of {total} · no contact info needed</p>
        <div className="qboxes" aria-hidden="true">
          {QUESTIONS.map((_, i) => <span key={i} className={`qb ${i < step ? 'on' : ''}`} />)}
        </div>
        <h1 style={{ margin: '18px 0 22px' }}>{q.q}</h1>
        {q.opts && q.opts.map(([v, label]) => (
          <button key={v} className="opt" onClick={() => answer(q.key, v)}>{label}</button>
        ))}
        {q.type === 'text' && (
          <form onSubmit={(e) => { e.preventDefault(); answer(q.key, textVal.trim()) }}>
            <div className="field"><input autoFocus value={textVal} onChange={(e) => setTextVal(e.target.value)} placeholder={q.ph} maxLength={40} /></div>
            <div className="pill-row">
              <button className="btn btn-primary" disabled={!textVal.trim()}>Continue</button>
              {q.skip && <button type="button" className="btn btn-ghost" onClick={() => answer(q.key, '')}>Skip</button>}
            </div>
          </form>
        )}
        {q.type === 'money' && (
          <form onSubmit={(e) => { e.preventDefault(); answer(q.key, String(Number(textVal.replace(/[$,\s]/g, '')) || 0)) }}>
            <div className="pill-row" style={{ marginBottom: 14 }}>
              {q.chips.map((c) => (
                <button key={c} type="button" className="btn btn-ghost btn-sm" onClick={() => answer(q.key, String(c))}>${c.toLocaleString()}</button>
              ))}
            </div>
            <div className="field"><input value={textVal} onChange={(e) => setTextVal(e.target.value)} placeholder="$2,800" inputMode="numeric" /></div>
            <div className="pill-row">
              <button className="btn btn-primary" disabled={!textVal.trim()}>Continue</button>
              {q.skip && <button type="button" className="btn btn-ghost" onClick={() => answer(q.key, '')}>I own / skip</button>}
            </div>
          </form>
        )}
      </div>
    )
  }

  // ── the assembled file ──────────────────────────────────────────────────────
  const name = answers.name || ''
  return (
    <div style={{ maxWidth: 560, margin: '8px auto' }}>
      <p className="fileno">West Coast Capital Mortgage · prepared {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>
      <div className="spread" style={{ marginBottom: 6 }}>
        <h1 className="mb0">File № {fileNo}</h1>
        <span className={`stamp ${activated ? 'ok' : ''}`}>{activated ? 'Activated' : 'Draft'}</span>
      </div>
      <p className="muted">{name ? `${name}, this` : 'This'} is your route to {file.buying ? 'the keys' : 'a better loan'} — built from your seven answers. Nothing here required your contact info.</p>

      <div className="card">
        <div className="card-head"><h2>Your route</h2><span className="chip">~{file.months} months to {file.buying ? 'keys' : 'close'}</span></div>
        {file.steps.map(([t, d], i) => (
          <div className="row" key={t}>
            <span className="big-num" style={{ fontSize: 22, minWidth: 26 }}>{i + 1}</span>
            <div className="grow"><div className="rlabel">{t}</div><div className="rsub">{d}</div></div>
          </div>
        ))}
      </div>

      {file.buying && file.target && file.monthly && (() => {
        const loan = file.target - file.downAmt
        const monthlyAt = loan * payFactor(rateSel) + file.target * TI_MONTHLY
        const pts = rateSel < BASE_RATE ? (BASE_RATE - rateSel) / 0.25 : 0
        const ptsCost = loan * 0.01 * pts
        const closeLow = file.target * 0.02, closeHigh = file.target * 0.03
        return (
          <div className="card">
            <div className="card-head">
              <h2>Your {money(file.target)}{answers.target === '3000' ? '+' : ''} plan</h2>
              <span className="chip">your numbers</span>
            </div>
            <p className="muted mt0" style={{ fontSize: 13.5 }}>Your target, your down payment — here’s the only number that matters:</p>
            <div className="big-num" style={{ fontSize: 40 }}>{money(monthlyAt)}<span style={{ fontSize: 18, color: 'var(--muted)' }}> / month</span></div>

            <div className="field" style={{ margin: '16px 0 4px' }}>
              <label htmlFor="pl-rate">At rate: <strong>{rateSel.toFixed(3)}%</strong> — slide to see it move</label>
              <input id="pl-rate" type="range" min="5.875" max="7.625" step="0.125" value={rateSel}
                onChange={(e) => setRateSel(Number(e.target.value))} />
              <p className="hint" style={{ marginTop: 2 }}>
                {pts > 0
                  ? <>Getting {rateSel.toFixed(3)}% ≈ <strong>{money(ptsCost)}</strong> in points ({pts.toFixed(1)} pt), paid at closing — saves <strong>{money(loan * (payFactor(BASE_RATE) - payFactor(rateSel)))}</strong>/mo.</>
                  : <>That’s today’s typical par rate — no points needed.</>}
                {' '}Your personal rate depends on credit, program and the day — activation gets you the real quote.
              </p>
            </div>

            <div className="metrics" style={{ marginTop: 12 }}>
              <div className="metric"><span className="lbl">Down payment ({Math.round(file.downPct * 100)}%)</span><span className="big-num" style={{ fontSize: 22 }}>{money(file.downAmt)}</span></div>
              <div className="metric"><span className="lbl">Loan</span><span className="big-num" style={{ fontSize: 22 }}>{money(loan)}</span></div>
              <div className="metric"><span className="lbl">Est. closing costs</span><span className="big-num" style={{ fontSize: 22 }}>{money(closeLow)}–{money(closeHigh)}</span></div>
              <div className="metric"><span className="lbl">Cash to close</span><span className="big-num" style={{ fontSize: 22, color: 'var(--st-processing)' }}>{money(file.downAmt + closeLow + ptsCost)}–{money(file.downAmt + closeHigh + ptsCost)}</span></div>
            </div>
            <p className="hint" style={{ marginTop: 12 }}>
              Monthly includes rough CA taxes &amp; insurance. Closing costs estimated at 2–3% (lender, title, escrow, prepaids{pts > 0 ? ', your points included in cash-to-close' : ''}).
              <strong> If this monthly feels right, the price is right</strong> — that’s the whole test.
              Estimates only, not an offer or approval.
            </p>
          </div>
        )
      })()}

      <div className="card">
        <div className="card-head"><h2>Programs matched to you</h2></div>
        {file.programs.map(([p, why]) => (
          <div className="row" key={p}>
            <div className="grow"><div className="rlabel">{p}</div><div className="rsub">{why}</div></div>
          </div>
        ))}
      </div>

      {file.buying && file.rent > 0 && <RentClock rent={file.rent} />}

      {file.buying && (
        <Link to="/who" className="card linkcard">
          <div className="spread">
            <div>
              <h2 className="mb0">Six people will send you forms</h2>
              <p className="mb0 muted" style={{ fontSize: 13.5 }}>Realtor, inspector, escrow, us… Here’s who sends what — so nothing ever confuses you.</p>
            </div>
            <span className="btn btn-ghost btn-sm">See the cast →</span>
          </div>
        </Link>
      )}

      {file.buying && (
        <div className="letter">
          <span className="letter-stamp" aria-hidden="true">Draft</span>
          <p className="fileno">Pre-approval letter · preview</p>
          <p style={{ margin: '10px 0 4px' }}><strong>Prepared for:</strong> {name || '____________'}</p>
          <p style={{ margin: 0 }}>
            West Coast Capital Mortgage Inc. is prepared to consider a loan request
            {file.letterMax ? <> toward a purchase of up to <strong>{money(file.letterMax)}</strong></> : null},
            subject to full underwriting, verification, and program guidelines.
          </p>
          <p className="fileno" style={{ marginTop: 14 }}>NMLS #2817729 · draft for illustration only — not a loan approval or commitment to lend</p>
        </div>
      )}

      <div className="card" id="activate">
        <div className="card-head"><h2>{activated ? 'File activated' : 'Activate this file'}</h2></div>
        {activated ? (
          <Alert kind="ok">Done — a human (not a bot) will text you within one business day{file.buying ? ' to turn the draft letter into a real one' : ' with your payoff math'}. Your file number is {fileNo}.</Alert>
        ) : (
          <form onSubmit={activate}>
            <p className="muted mt0" style={{ fontSize: 13.5 }}>One step: where do we send the real version? No credit pull until you say so.</p>
            <Alert kind="error">{error}</Alert>
            <div className="grid2">
              <div className="field"><label htmlFor="a-em">Email</label><input id="a-em" type="email" required value={contact.email} onChange={(e) => setContact((c) => ({ ...c, email: e.target.value }))} inputMode="email" /></div>
              <div className="field"><label htmlFor="a-ph">Mobile</label><input id="a-ph" type="tel" required value={contact.phone} onChange={(e) => setContact((c) => ({ ...c, phone: e.target.value }))} inputMode="tel" /></div>
            </div>
            <div className="field checkline">
              <input id="a-consent" type="checkbox" checked={contact.consent} onChange={(e) => setContact((c) => ({ ...c, consent: e.target.checked }))} />
              <label htmlFor="a-consent">{SMS_CONSENT_TEXT}</label>
            </div>
            <button className="btn btn-primary btn-block btn-lg" disabled={busy}>{busy ? 'Activating…' : `Activate file ${fileNo}`}</button>
          </form>
        )}
      </div>

      <div className="card">
        <div className="card-head"><h2>Not today? Set a rate alarm</h2></div>
        {alarmSet ? (
          <Alert kind="ok">Alarm set at {alarmRate.toFixed(3)}%. We’ll only reach out when the market gets there.</Alert>
        ) : (
          <form onSubmit={setAlarm}>
            <div className="field">
              <label htmlFor="al-rate">Call me when rates reach: <strong>{alarmRate.toFixed(3)}%</strong></label>
              <input id="al-rate" type="range" min="5" max="7.5" step="0.125" value={alarmRate}
                onChange={(e) => setAlarmRate(Number(e.target.value))} />
            </div>
            <div className="spread">
              <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                <input type="email" required placeholder="you@example.com" value={alarmEmail} onChange={(e) => setAlarmEmail(e.target.value)} inputMode="email" />
              </div>
              <button className="btn btn-ghost">Set alarm</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
