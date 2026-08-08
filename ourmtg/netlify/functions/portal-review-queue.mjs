// GET /.netlify/functions/portal-review-queue   (LO/owner-authed, Bearer JWT)
//
// Read-only LO queue: every loan_file the caller owns, with missing/pending-review
// document counts, open condition counts, last borrower activity, a simple "stuck"
// flag, and a one-line next action. This is the DATA endpoint behind the future LO
// dashboard — no UI here.
//
// SECURITY: internal-scoped. A normal owner/team member sees only the explicitly related
// owner portfolios. A platform admin sees the portfolios of configured platform admins only.
// The configured allowlist is resolved to verified Supabase Auth identities server-side; the
// browser never supplies an owner id. Application progress comes from the stored deterministic
// mortgage_applications status, never from AI output or a client claim.

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, stageInfo, isPlatformAdmin, parseAdminEmails,
} from './_lib/portal.mjs'
import { checklistFor } from './_lib/checklist.mjs'
import { applicationProgress, summarizeOwners } from './_lib/portfolio.mjs'

// MVP heuristic, intentionally simple: a file is "stuck" when it still has missing
// documents AND nothing has happened (no portal message, or no activity at all since
// creation) in over STUCK_HOURS. A real staleness model is a 90-day-plan item.
const STUCK_HOURS = 72

async function configuredAdminAccounts(svc, rawAllowlist) {
  const emails = parseAdminEmails(rawAllowlist)
  const wanted = new Set(emails)
  const found = new Map()

  for (let page = 1; page <= 100 && found.size < wanted.size; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw new Error('admin identity lookup: ' + error.message)
    const users = data?.users || []
    for (const user of users) {
      const email = String(user.email || '').trim().toLowerCase()
      if (wanted.has(email)) found.set(email, user)
    }
    if (users.length < 1000) break
  }

  // Keep configured admins with no Auth account visible as zero-file portfolios. They cannot
  // own or open a file until they authenticate, and userId remains null instead of being guessed.
  return emails.map((email) => {
    const user = found.get(email)
    return {
      userId: user?.id || null,
      email,
      relation: 'admin',
      lastSignInAt: user?.last_sign_in_at || null,
    }
  })
}

async function relatedOwnerAccounts(svc, auth, memberships, files) {
  const membershipByOwner = new Map((memberships || []).map((m) => [m.owner_user_id, m.role]))
  const ids = new Set(membershipByOwner.keys())
  if (files.some((file) => file.owner_user_id === auth.user.id)) ids.add(auth.user.id)

  const owners = []
  for (const userId of ids) {
    if (userId === auth.user.id) {
      owners.push({ userId, email: auth.user.email || null, relation: 'self', lastSignInAt: null })
      continue
    }
    let email = null
    try {
      const { data } = await svc.auth.admin.getUserById(userId)
      email = data?.user?.email || null
    } catch { /* identity remains explicitly unknown */ }
    owners.push({
      userId,
      email,
      relation: membershipByOwner.get(userId) || 'team',
      lastSignInAt: null,
    })
  }
  return owners
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const svc = admin()

  // Owner set is entirely server-derived. Platform admins can compare configured admin
  // portfolios; processors/assistants remain limited to their portal_team relationships.
  const { data: memberships, error: tErr } = await svc
    .from('portal_team')
    .select('owner_user_id, role')
    .eq('member_user_id', auth.user.id)
  if (tErr && tErr.code !== '42P01') return json({ ok: false, error: 'Database error' }, 500)

  const platformAdmin = isPlatformAdmin(auth.user.email, process.env.OURMTG_ADMIN_EMAILS)
  const recognizedInternal = platformAdmin
    || (!tErr && (memberships || []).length > 0)

  let configuredAdmins = []
  try {
    if (platformAdmin) configuredAdmins = await configuredAdminAccounts(svc, process.env.OURMTG_ADMIN_EMAILS)
  } catch (error) {
    console.error('[portal-review-queue]', error.message)
    return json({ ok: false, error: 'Could not verify admin identities' }, 500)
  }

  // Full file detail remains owner/team scoped even for a platform admin. Platform authority
  // can see operational aggregates for configured admins, but it does not silently become
  // borrower-financial access. To open another owner's file, the caller must be on portal_team.
  const accessOwnerIds = [...new Set([auth.user.id, ...(memberships || []).map((m) => m.owner_user_id)])]
  const overviewOwnerIds = platformAdmin
    ? configuredAdmins.map((owner) => owner.userId).filter(Boolean)
    : accessOwnerIds
  const queryOwnerIds = [...new Set([...accessOwnerIds, ...overviewOwnerIds])]

  const identity = {
    userId: auth.user.id,
    email: auth.user.email || null,
    provider: auth.user.app_metadata?.provider || null,
  }

  if (!queryOwnerIds.length) {
    return json({
      ok: true,
      files: [],
      internal: recognizedInternal,
      workspace: {
        identity, platformAdmin, accessibleOwnerIds: accessOwnerIds,
        owners: summarizeOwners(configuredAdmins, []),
      },
    })
  }

  const { data: files, error: fErr } = await svc
    .from('loan_files')
    .select('*')
    .in('owner_user_id', queryOwnerIds)
    .order('updated_at', { ascending: false })
  if (fErr) return json({ ok: false, error: 'Database error' }, 500)

  const allFiles = files || []
  const accessibleOwnerSet = new Set(accessOwnerIds)
  const overviewOwnerSet = new Set(overviewOwnerIds)
  const accessibleFiles = allFiles.filter((file) => accessibleOwnerSet.has(file.owner_user_id))
  const overviewFiles = allFiles.filter((file) => overviewOwnerSet.has(file.owner_user_id))
  const relatedOwners = await relatedOwnerAccounts(svc, auth, memberships || [], accessibleFiles)
  const ownerAccounts = platformAdmin
    ? [
        ...configuredAdmins,
        ...relatedOwners.filter((related) => !configuredAdmins.some((admin) => admin.userId === related.userId)),
      ]
    : relatedOwners

  if (allFiles.length === 0) {
    return json({
      ok: true,
      files: [],
      internal: recognizedInternal,
      workspace: {
        identity, platformAdmin, accessibleOwnerIds: accessOwnerIds,
        owners: summarizeOwners(ownerAccounts, []),
      },
    })
  }

  const accessibleIds = accessibleFiles.map((f) => f.id)
  const overviewIds = overviewFiles.map((f) => f.id)
  const allApplicationIds = [...new Set([...accessibleIds, ...overviewIds])]
  const emptyResult = Promise.resolve({ data: [], error: null })
  const [docsResult, msgsResult, condsResult, appsResult] = await Promise.all([
    accessibleIds.length
      ? svc.from('loan_documents').select('loan_file_id, doc_key, status').in('loan_file_id', accessibleIds)
      : emptyResult,
    accessibleIds.length
      ? svc.from('loan_messages').select('loan_file_id, created_at').in('loan_file_id', accessibleIds).order('created_at', { ascending: false })
      : emptyResult,
    accessibleIds.length
      ? svc.from('loan_conditions').select('loan_file_id').in('loan_file_id', accessibleIds).eq('status', 'open')
      : emptyResult,
    svc.from('mortgage_applications')
      .select('loan_file_id, application_version, status, percent_complete, updated_at')
      .in('loan_file_id', allApplicationIds),
  ])
  if ([docsResult, msgsResult, condsResult, appsResult].some((result) => result.error)) {
    return json({ ok: false, error: 'Database error' }, 500)
  }
  const docs = docsResult.data
  const msgs = msgsResult.data
  const conds = condsResult.data

  // There may be historical application versions. Highest version is the current one; no
  // completeness is recomputed here.
  const applicationByFile = new Map()
  for (const app of [...(appsResult.data || [])].sort(
    (a, b) => Number(b.application_version || 0) - Number(a.application_version || 0),
  )) {
    if (!applicationByFile.has(app.loan_file_id)) applicationByFile.set(app.loan_file_id, app)
  }
  const ownerById = new Map(ownerAccounts.filter((owner) => owner.userId).map((owner) => [owner.userId, owner]))

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
  const rows = accessibleFiles.map((f) => {
    const required = checklistFor({ loanType: f.loan_type, purpose: f.purpose })
    const fileDocs = docsByFile.get(f.id) || []
    const doneKeys = new Set(fileDocs.filter((d) => ['uploaded', 'accepted'].includes(d.status)).map((d) => d.doc_key))
    const requiredKeys = new Set(required.map((r) => r.doc_key))
    // Missing = standard checklist gaps + ad-hoc requests still awaiting an upload.
    const customPending = fileDocs.filter(
      (d) => !requiredKeys.has(d.doc_key) && ['requested', 'rejected'].includes(d.status),
    ).length
    const missingDocs = required.filter((r) => !doneKeys.has(r.doc_key)).length + customPending
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
      ownerUserId: f.owner_user_id,
      ownerEmail: ownerById.get(f.owner_user_id)?.email || null,
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
      application: applicationProgress(applicationByFile.get(f.id)),
    }
  })

  const aggregateRows = overviewFiles.map((file) => ({
    ownerUserId: file.owner_user_id,
    stage: file.stage,
    application: applicationProgress(applicationByFile.get(file.id)),
  }))
  // Explicitly related non-admin owner portfolios (if any) also belong in the caller's summary.
  for (const file of accessibleFiles) {
    if (!overviewOwnerSet.has(file.owner_user_id)) {
      aggregateRows.push({
        ownerUserId: file.owner_user_id,
        stage: file.stage,
        application: applicationProgress(applicationByFile.get(file.id)),
      })
    }
  }

  return json({
    ok: true,
    files: rows,
    internal: true,
    workspace: {
      identity,
      platformAdmin,
      accessibleOwnerIds: accessOwnerIds,
      owners: summarizeOwners(ownerAccounts, aggregateRows),
    },
  })
}
