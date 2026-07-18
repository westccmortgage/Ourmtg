// Create an analysis from uploaded digital PDF bank statements. PDF extraction only
// suggests statement month + total deposits. Every row remains human-review-required.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, logAccess } from './_lib/portal.mjs'
import { calculateStatementIncome } from './_lib/statement-income.mjs'
import { extractPdfStatementSummaries } from './_lib/statement-pdf.mjs'
const BUCKET = 'ourmtg-docs'

const validPct = (value, fallback) => {
  const number = Number(value ?? fallback)
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const loanFileId = String(body.loanFileId || '').trim()
  const documentIds = [...new Set((body.documentIds || []).map((id) => String(id).trim()).filter(Boolean))]
  const statementType = String(body.statementType || 'business')
  const periodMonths = Number(body.periodMonths || 12)
  const expenseFactorPct = validPct(body.expenseFactorPct, statementType === 'business' ? 50 : 0)
  const ownershipPct = validPct(body.ownershipPct, 100)
  if (!loanFileId) return json({ ok: false, error: 'Missing loanFileId' }, 400)
  if (!documentIds.length || documentIds.length > 24) return json({ ok: false, error: 'Select 1 to 24 uploaded statements' }, 400)
  if (!['personal', 'business'].includes(statementType)) return json({ ok: false, error: 'Invalid statementType' }, 400)
  if (![12, 24].includes(periodMonths)) return json({ ok: false, error: 'periodMonths must be 12 or 24' }, 400)
  if (expenseFactorPct == null || ownershipPct == null) return json({ ok: false, error: 'Percent values must be between 0 and 100' }, 400)

  const svc = admin()
  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch {
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!isInternal(access)) return json({ ok: false, error: 'Not authorized' }, 403)

  const { data: documents, error: documentError } = await svc.from('loan_documents')
    .select('id, label, status, storage_path')
    .eq('loan_file_id', loanFileId).in('id', documentIds)
  if (documentError || documents?.length !== documentIds.length) return json({ ok: false, error: 'One or more documents are unavailable' }, 400)
  if (documents.some((doc) => !doc.storage_path || !['uploaded', 'accepted'].includes(doc.status))) {
    return json({ ok: false, error: 'Every selected statement must be uploaded first' }, 409)
  }

  const { data: analysis, error: analysisError } = await svc.from('statement_income_analyses').insert({
    loan_file_id: loanFileId,
    owner_user_id: loanFile.owner_user_id,
    status: 'needs_review',
    statement_type: statementType,
    period_months: periodMonths,
    expense_factor_pct: statementType === 'business' ? expenseFactorPct : 0,
    ownership_pct: statementType === 'business' ? ownershipPct : 100,
    created_by: auth.user.id,
  }).select('*').maybeSingle()
  if (analysisError) {
    if (['42P01', 'PGRST205'].includes(analysisError.code)) return json({ ok: false, error: 'Statement analysis database delta is not applied' }, 503)
    return json({ ok: false, error: 'Could not create statement analysis' }, 500)
  }

  const monthRows = []
  try {
    for (const doc of documents) {
      let summaries = [{ statementMonth: null, totalDeposits: null, extractionStatus: 'unreadable' }]
      try {
        const { data: blob, error: downloadError } = await svc.storage.from(BUCKET).download(doc.storage_path)
        if (downloadError || !blob) throw new Error('download failed')
        if ((blob.type || '').toLowerCase().includes('pdf')) {
          summaries = await extractPdfStatementSummaries(Buffer.from(await blob.arrayBuffer()))
        }
      } catch {
        summaries = [{ statementMonth: null, totalDeposits: null, extractionStatus: 'unreadable' }]
      }
      for (const summary of summaries) {
        monthRows.push({
          analysis_id: analysis.id,
          loan_file_id: loanFileId,
          source_document_id: doc.id,
          account_label: doc.label,
          statement_month: summary.statementMonth,
          total_deposits: summary.totalDeposits,
          excluded_deposits: 0,
          extraction_status: summary.extractionStatus,
          needs_review: true,
        })
      }
    }

    const { data: inserted, error: insertError } = await svc.from('statement_income_months').insert(monthRows).select('*')
    if (insertError) throw insertError
    const calculation = calculateStatementIncome({
      months: (inserted || []).map((row) => ({
        statementMonth: row.statement_month,
        totalDeposits: row.total_deposits,
        excludedDeposits: row.excluded_deposits,
        needsReview: row.needs_review,
      })),
      statementType,
      periodMonths,
      expenseFactorPct,
      ownershipPct,
    })
    await svc.from('statement_income_analyses').update({
      calculation,
      calculated_monthly_income: calculation.qualifyingMonthlyIncome,
    }).eq('id', analysis.id)
    await svc.from('statement_income_analyses').update({ status: 'superseded', borrower_visible: false })
      .eq('loan_file_id', loanFileId).neq('id', analysis.id).neq('status', 'superseded')

    await logAccess(svc, { portalUser: auth.user.id, loanFileId, action: 'statement_analysis_created', target: analysis.id, req })
    return json({ ok: true, analysisId: analysis.id, calculation })
  } catch (error) {
    await svc.from('statement_income_analyses').delete().eq('id', analysis.id)
    console.error('[portal-statement-analysis-create] processing failed:', error?.message || error)
    return json({ ok: false, error: 'Could not process the selected statements' }, 500)
  }
}
