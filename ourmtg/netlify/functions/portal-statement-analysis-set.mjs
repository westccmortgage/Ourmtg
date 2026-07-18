// Save the human-reviewed monthly worksheet or confirm its reviewed income. Confirming
// an analysis does NOT set loan_files.preapproval_* and does not issue a pre-approval.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, logAccess } from './_lib/portal.mjs'
import { calculateStatementIncome } from './_lib/statement-income.mjs'

const safePct = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null
}
const safeMoney = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

async function recalculate(svc, analysis) {
  const { data: months, error } = await svc.from('statement_income_months').select('*')
    .eq('analysis_id', analysis.id).order('statement_month', { ascending: true })
  if (error) throw error
  const calculation = calculateStatementIncome({
    months: (months || []).map((row) => ({
      statementMonth: row.statement_month,
      totalDeposits: row.total_deposits,
      excludedDeposits: row.excluded_deposits,
      needsReview: row.needs_review,
    })),
    statementType: analysis.statement_type,
    periodMonths: analysis.period_months,
    expenseFactorPct: analysis.expense_factor_pct,
    ownershipPct: analysis.ownership_pct,
  })
  const { error: updateError } = await svc.from('statement_income_analyses').update({
    calculation,
    calculated_monthly_income: calculation.qualifyingMonthlyIncome,
  }).eq('id', analysis.id)
  if (updateError) throw updateError
  return calculation
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)
  const body = await req.json().catch(() => ({}))
  const analysisId = String(body.analysisId || '').trim()
  const action = String(body.action || 'save')
  if (!analysisId) return json({ ok: false, error: 'Missing analysisId' }, 400)
  if (!['save', 'review'].includes(action)) return json({ ok: false, error: 'Invalid action' }, 400)

  const svc = admin()
  const { data: analysis, error: analysisError } = await svc.from('statement_income_analyses')
    .select('*').eq('id', analysisId).maybeSingle()
  if (analysisError) return json({ ok: false, error: 'Database error' }, 500)
  if (!analysis) return json({ ok: false, error: 'Analysis not found' }, 404)
  const loanFile = await loadLoanFile(svc, analysis.loan_file_id).catch(() => null)
  const access = await resolveAccess(svc, auth.user.id, loanFile).catch(() => null)
  if (!isInternal(access)) return json({ ok: false, error: 'Not authorized' }, 403)
  if (analysis.status === 'superseded') return json({ ok: false, error: 'Analysis has been superseded' }, 409)

  if (action === 'save') {
    const factor = safePct(body.expenseFactorPct)
    const ownership = safePct(body.ownershipPct)
    if (factor == null || ownership == null) return json({ ok: false, error: 'Percent values must be between 0 and 100' }, 400)
    const rows = Array.isArray(body.months) ? body.months : []
    if (!rows.length || rows.length > 48) return json({ ok: false, error: 'Monthly worksheet is required' }, 400)

    for (const row of rows) {
      const total = safeMoney(row.totalDeposits)
      const excluded = safeMoney(row.excludedDeposits)
      const month = /^20\d{2}-(0[1-9]|1[0-2])-01$/.test(String(row.statementMonth || '')) ? row.statementMonth : null
      if (!row.id || total == null || excluded == null || excluded > total || !month) {
        return json({ ok: false, error: 'Every month needs a valid month, deposits, and exclusions' }, 400)
      }
      const { error } = await svc.from('statement_income_months').update({
        statement_month: month,
        total_deposits: total,
        excluded_deposits: excluded,
        extraction_status: 'manual',
        needs_review: false,
        reviewer_note: String(row.reviewerNote || '').trim().slice(0, 1000) || null,
      }).eq('id', row.id).eq('analysis_id', analysisId)
      if (error) return json({ ok: false, error: 'Could not save monthly worksheet' }, 500)
    }
    analysis.expense_factor_pct = analysis.statement_type === 'business' ? factor : 0
    analysis.ownership_pct = analysis.statement_type === 'business' ? ownership : 100
    const { error: settingsError } = await svc.from('statement_income_analyses').update({
      expense_factor_pct: analysis.expense_factor_pct,
      ownership_pct: analysis.ownership_pct,
      status: 'needs_review',
      borrower_visible: false,
      reviewed_monthly_income: null,
      reviewed_by: null,
      reviewed_at: null,
    }).eq('id', analysisId)
    if (settingsError) return json({ ok: false, error: 'Could not save analysis settings' }, 500)
    const calculation = await recalculate(svc, analysis)
    await logAccess(svc, { portalUser: auth.user.id, loanFileId: analysis.loan_file_id, action: 'statement_analysis_saved', target: analysisId, req })
    return json({ ok: true, analysisId, calculation })
  }

  const calculation = await recalculate(svc, analysis).catch(() => null)
  if (!calculation) return json({ ok: false, error: 'Could not recalculate analysis' }, 500)
  if (!calculation.readyForHumanReview || calculation.reviewRequired > 0) {
    return json({ ok: false, error: 'Review every required statement month before confirming income' }, 409)
  }
  const reviewedIncome = body.reviewedMonthlyIncome == null
    ? calculation.qualifyingMonthlyIncome
    : safeMoney(body.reviewedMonthlyIncome)
  if (reviewedIncome == null || reviewedIncome <= 0) return json({ ok: false, error: 'Reviewed monthly income must be positive' }, 400)
  const reviewerNotes = String(body.reviewerNotes || '').trim().slice(0, 4000) || null
  const { error: reviewError } = await svc.from('statement_income_analyses').update({
    status: 'reviewed',
    reviewed_monthly_income: reviewedIncome,
    reviewer_notes: reviewerNotes,
    borrower_visible: true,
    reviewed_by: auth.user.id,
    reviewed_at: new Date().toISOString(),
  }).eq('id', analysisId)
  if (reviewError) return json({ ok: false, error: 'Could not confirm reviewed income' }, 500)
  await logAccess(svc, { portalUser: auth.user.id, loanFileId: analysis.loan_file_id, action: 'statement_analysis_reviewed', target: analysisId, req })
  return json({ ok: true, analysisId, reviewedMonthlyIncome: reviewedIncome })
}
