// GET /.netlify/functions/portal-review-queue   (LO/owner-authed, Bearer JWT)
//
// Read-only LO queue: every loan_file the caller owns, with missing/pending-review
// document counts, open condition counts, last borrower activity, a simple "stuck"
// flag, and a one-line next action. This is the DATA endpoint behind the future LO
// dashboard — no UI here.
//
// SECURITY: owner-scoped only (loan_files.owner_user_id = caller). Reads loan_files /
// loan_documents / loan_conditions / loan_messages ONLY — never app_state, never
// another owner's files.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, stageInfo } from './_lib/portal.mjs'
import { checklistFor } from './_lib/checklist.mjs'

// MVP heuristic, intentionally simple: a file is "stuck" when it still has missing
// documents AND nothing has happened (no portal message, or no activity at all since
// creation) in over STUCK_HOURS. A real staleness model is a 90-day-plan item.
const STUCK_HOURS = 72

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const svc = admin()

  const { data: files, error: fErr } = await svc
    .from('loan_files')
    .select('*')
    .eq('owner_user_id', auth.user.id)
    .order('updated_at', { ascending: false })
  if (fErr) return json({ ok: false, error: 'Database error' }, 500)

  if (!files || files.length === 0) return json({ ok: true, files: [] })

  const ids = files.map((f) => f.id)
  const [{ data: docs }, { data: msgs }, { data: conds }] = await Promise.all([
    svc.from('loan_documents').select('loan_file_id, doc_key, status').in('loan_file_id', ids),
    svc.from('loan_messages').select('loan_file_id, created_at').in('loan_file_id', ids).order('created_at', { ascending: false }),
    svc.from('loan_conditions').select('loan_file_id').in('loan_file_id', ids).eq('status', 'open'),
  ])

  const docsByFile = new Map()
  for (const d of docs || []) {
    if (!docsByFile.has(d.loan_file_id)) docsByFile.set(d.loan_file_id, [])
    docsByFile.get(d.loan_file_id).push(d)
  }
  // msgs are sorted desc, so the first row seen per file is its most recent activity.
  const lastActivityByFile = new Map()
  for (const m of msgs || []) {
    if (!lastActivityByFile.has(m.loan_file_id)) lastActivityByFile.set(m.loan_file_id, m.created_at)
  }
  const openCondByFile = new Map()
  for (const c of conds || []) {
    openCondByFile.set(c.loan_file_id, (openCondByFile.get(c.loan_file_id) || 0) + 1)
  }

  const now = Date.now()
  const rows = files.map((f) => {
    const required = checklistFor({ loanType: f.loan_type, purpose: f.purpose })
    const fileDocs = docsByFile.get(f.id) || []
    const doneKeys = new Set(fileDocs.filter((d) => ['uploaded', 'accepted'].includes(d.status)).map((d) => d.doc_key))
    const missingDocs = required.filter((r) => !doneKeys.has(r.doc_key)).length
    const pendingReview = fileDocs.filter((d) => d.status === 'uploaded').length
    const openConditions = openCondByFile.get(f.id) || 0
    const lastActivity = lastActivityByFile.get(f.id) || null
    const hoursSinceActivity = (now - new Date(lastActivity || f.created_at).getTime()) / 36e5
    const stuck = missingDocs > 0 && hoursSinceActivity > STUCK_HOURS

    let nextAction = 'No action needed'
    if (missingDocs > 0) nextAction = `Waiting on ${missingDocs} document${missingDocs === 1 ? '' : 's'} from borrower`
    else if (pendingReview > 0) nextAction = `Review ${pendingReview} uploaded document${pendingReview === 1 ? '' : 's'}`
    else if (openConditions > 0) nextAction = `Review ${openConditions} outstanding condition${openConditions === 1 ? '' : 's'}`

    return {
      loanFileId: f.id,
      borrowerName: f.borrower_name || null,
      loanNumber: f.loan_number || null,
      stage: f.stage,
      stageLabel: stageInfo(f.stage).label,
      amount: f.amount != null ? Number(f.amount) : null,
      estCloseDate: f.est_close_date || null,
      missingDocs,
      pendingReview,
      openConditions,
      lastActivity,
      stuck,
      nextAction,
    }
  })

  return json({ ok: true, files: rows })
}
