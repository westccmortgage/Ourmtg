// GET reviewed Statement Income Analysis summary for borrowers, or the full worksheet
// for an authorized loan-team user. Raw monthly values never use browser-table grants.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, canSeeFinancials, logAccess } from './_lib/portal.mjs'

const number = (value) => value == null ? null : Number(value)

function analysisView(row, months, internal) {
  const base = {
    id: row.id,
    status: row.status,
    statementType: row.statement_type,
    periodMonths: row.period_months,
    reviewedMonthlyIncome: number(row.reviewed_monthly_income),
    reviewedAt: row.reviewed_at,
    borrowerVisible: !!row.borrower_visible,
  }
  if (!internal) return base
  return {
    ...base,
    expenseFactorPct: number(row.expense_factor_pct),
    ownershipPct: number(row.ownership_pct),
    calculatedMonthlyIncome: number(row.calculated_monthly_income),
    calculation: row.calculation || {},
    reviewerNotes: row.reviewer_notes || null,
    months: (months || []).map((month) => ({
      id: month.id,
      sourceDocumentId: month.source_document_id,
      accountLabel: month.account_label,
      statementMonth: month.statement_month,
      totalDeposits: number(month.total_deposits),
      excludedDeposits: number(month.excluded_deposits) || 0,
      extractionStatus: month.extraction_status,
      needsReview: !!month.needs_review,
      reviewerNote: month.reviewer_note || null,
    })),
  }
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)
  const loanFileId = String(new URL(req.url).searchParams.get('loanFileId') || '').trim()
  if (!loanFileId) return json({ ok: false, error: 'Missing loanFileId' }, 400)

  const svc = admin()
  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch {
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!access || !canSeeFinancials(access.visibility)) return json({ ok: false, error: 'Not authorized' }, 403)

  const internal = isInternal(access)
  let query = svc.from('statement_income_analyses').select('*')
    .eq('loan_file_id', loanFileId)
    .neq('status', 'superseded')
    .order('created_at', { ascending: false }).limit(1)
  if (!internal) query = query.eq('status', 'reviewed').eq('borrower_visible', true)
  const { data: rows, error } = await query
  if (error) {
    if (['42P01', 'PGRST205'].includes(error.code)) return json({ ok: true, analysis: null, available: false })
    return json({ ok: false, error: 'Database error' }, 500)
  }
  const row = rows?.[0]
  if (!row) return json({ ok: true, analysis: null, available: true })

  let months = []
  if (internal) {
    const { data, error: monthError } = await svc.from('statement_income_months').select('*')
      .eq('analysis_id', row.id).order('statement_month', { ascending: true })
    if (monthError) return json({ ok: false, error: 'Database error' }, 500)
    months = data || []
  }

  await logAccess(svc, { portalUser: auth.user.id, loanFileId, action: 'statement_analysis_view', target: internal ? 'internal' : 'borrower_summary', req })
  return json({ ok: true, analysis: analysisView(row, months, internal), available: true })
}
