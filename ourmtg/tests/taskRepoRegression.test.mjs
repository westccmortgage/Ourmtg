// Regression coverage retained from the pre-FCG repository suite. These adapter tests are
// intentionally separate from taskRepo.test.mjs so the final contract adds coverage rather than
// deleting prior security/idempotency/atomicity scenarios. They are not live-database tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaskRepo, scrubTaskForBorrower } from '../netlify/functions/_lib/taskRepo.mjs'

const graph = {
  assigned: { view: 'viewed', begin: 'in_progress', cancel: 'cancelled' },
  viewed: { begin: 'in_progress', cancel: 'cancelled' },
  in_progress: { submit: 'submitted', cancel: 'cancelled' },
  submitted: { precheck: 'prechecked', sendToTeamReview: 'team_review', reject: 'rejected', requestMoreInfo: 'more_information_needed', cancel: 'cancelled' },
  prechecked: { sendToTeamReview: 'team_review', reject: 'rejected', requestMoreInfo: 'more_information_needed', cancel: 'cancelled' },
  team_review: { accept: 'accepted', reject: 'rejected', requestMoreInfo: 'more_information_needed' },
  rejected: { begin: 'in_progress', reopen: 'reopened', cancel: 'cancelled' },
  more_information_needed: { begin: 'in_progress', submit: 'submitted', cancel: 'cancelled' },
  accepted: { complete: 'completed', reopen: 'reopened' },
  completed: { reopen: 'reopened' },
  reopened: { assign: 'assigned', begin: 'in_progress', cancel: 'cancelled' },
}
const eventFor = { view: 'task.viewed', begin: 'task.started', submit: 'task.submitted', precheck: 'task.prechecked', sendToTeamReview: 'task.team_review', accept: 'task.accepted', reject: 'task.rejected', requestMoreInfo: 'task.more_information_needed', complete: 'task.completed', reopen: 'task.reopened', cancel: 'task.cancelled', assign: 'task.assigned' }
const lo = { type: 'loan_officer', id: 'lo' }
const b1 = { type: 'borrower', id: 'b1' }
const b2 = { type: 'coborrower', id: 'b2' }

function dbFake({ throwRpc = false } = {}) {
  let seq = 0
  const tasks = new Map(), docs = new Map([
    ['d1', { id: 'd1', loan_file_id: 'f', status: 'requested', who: 'borrower' }],
    ['d2', { id: 'd2', loan_file_id: 'f', status: 'requested', who: 'coborrower' }],
    ['dx', { id: 'dx', loan_file_id: 'other', status: 'requested', who: 'borrower' }],
  ])
  const history = [], events = []
  const idem = (key) => events.find((e) => e.idempotency_key === key)
  const rows = (table) => table === 'loan_tasks' ? [...tasks.values()] : table === 'loan_task_history' ? history : table === 'loan_events' ? events : [...docs.values()]
  const builder = (arr) => {
    const filters = []
    const apply = () => arr.filter((r) => filters.every((f) => f.type === 'eq' ? r[f.k] === f.v : f.type === 'in' ? f.v.includes(r[f.k]) : f.clauses.some((c) => c.k === 'shared_with_borrowers' ? r[c.k] === true : r[c.k] === c.v)))
    const q = { select(){return q}, eq(k,v){filters.push({type:'eq',k,v});return q}, in(k,v){filters.push({type:'in',k,v});return q}, or(expr){filters.push({type:'or',clauses:String(expr).split(',').map((x)=>{const [k,,v]=x.split('.');return{k,v}})});return q}, order(){return Promise.resolve({data:apply(),error:null})}, maybeSingle(){return Promise.resolve({data:apply()[0]||null,error:null})}, then(fn){return Promise.resolve({data:apply(),error:null}).then(fn)} }
    return q
  }
  function duplicate(e) { return { ok:true,deduped:true,task_id:e.source_record_id,...e.result } }
  async function rpc(name,p) {
    if (throwRpc) throw new Error('transport')
    if (!p.p_idempotency_key || !p.p_request_hash) return {data:null,error:{message:'idempotency_required'}}
    const prior = idem(p.p_idempotency_key)
    if (prior) return prior.request_hash === p.p_request_hash ? {data:duplicate(prior),error:null} : {data:null,error:{message:'idempotency_conflict'}}
    if (name === 'ourmtg_task_create') {
      if (p.p_organization_id !== 'org' || p.p_loan_file_id !== 'f') return {data:null,error:{message:'loan_org_mismatch'}}
      if (!p.p_shared_with_borrowers && !['b1','b2'].includes(p.p_responsible_user_id)) return {data:null,error:{message:'participant_invalid'}}
      const doc = docs.get(p.p_required_document_id)
      if (!doc || doc.loan_file_id !== 'f') return {data:null,error:{message:'document_binding_mismatch'}}
      const party = p.p_responsible_user_id === 'b2' ? 'coborrower' : 'borrower'
      const id = `t${++seq}`
      tasks.set(id,{id,organization_id:'org',loan_file_id:'f',task_type:p.p_task_type,title:p.p_title,status:'assigned',revision:1,responsible_party_type:party,responsible_user_id:p.p_responsible_user_id||null,shared_with_borrowers:!!p.p_shared_with_borrowers,required_document_id:doc.id,internal_requirement:p.p_internal_requirement,metadata:{private:true}})
      history.push({task_id:id,from_status:null,to_status:'created'},{task_id:id,from_status:'created',to_status:'assigned'})
      const result={status:'assigned',revision:1};events.push({event_type:'task.created',idempotency_key:p.p_idempotency_key,request_hash:p.p_request_hash,source_record_id:id,result},{event_type:'task.assigned',idempotency_key:`assign:${p.p_idempotency_key}`},{event_type:'notification.queued',idempotency_key:`intent:${p.p_idempotency_key}`,metadata:{intent:'borrower_task_created'}})
      return {data:{ok:true,deduped:false,task_id:id,...result},error:null}
    }
    const task=tasks.get(p.p_task_id); if(!task)return{data:null,error:{message:'task_not_found'}}
    if(p.p_organization_id!=='org')return{data:null,error:{message:'loan_org_mismatch'}}
    if(name==='ourmtg_task_transition'){
      if(task.revision!==p.p_expected_revision)return{data:null,error:{message:'stale_task'}}
      const to=graph[task.status]?.[p.p_action];if(!to)return{data:null,error:{message:'invalid_transition'}}
      if(['borrower','coborrower'].includes(p.p_actor_type)&&!['viewed','in_progress','submitted'].includes(to))return{data:null,error:{message:'forbidden_action'}}
      if(['reject','requestMoreInfo','reopen'].includes(p.p_action)&&!String(p.p_borrower_visible_reason||'').trim())return{data:null,error:{message:'reason_required'}}
      const from=task.status,revision=++task.revision;task.status=to
      if(['reject','requestMoreInfo','reopen'].includes(p.p_action))task.borrower_visible_status_reason=p.p_borrower_visible_reason
      if(['in_progress','submitted','accepted','completed'].includes(to))task.borrower_visible_status_reason=null
      history.push({task_id:task.id,from_status:from,to_status:to})
      const result={from,to,revision};events.push({event_type:eventFor[p.p_action],idempotency_key:p.p_idempotency_key,request_hash:p.p_request_hash,source_record_id:task.id,result})
      if(['reject','requestMoreInfo','reopen'].includes(p.p_action))events.push({event_type:'notification.queued',idempotency_key:`intent:${p.p_idempotency_key}`,metadata:{intent:p.p_action}})
      return{data:{ok:true,deduped:false,task_id:task.id,...result},error:null}
    }
    if(name==='ourmtg_document_finalize_submit'){
      const doc=docs.get(p.p_document_id);if(!doc)return{data:null,error:{message:'document_not_found'}}
      if(doc.loan_file_id!==task.loan_file_id)return{data:null,error:{message:'cross_loan_document'}}
      if(task.required_document_id!==doc.id)return{data:null,error:{message:'document_binding_mismatch'}}
      if(task.revision!==p.p_expected_revision)return{data:null,error:{message:'stale_task'}}
      if(task.status!=='in_progress')return{data:null,error:{message:'invalid_transition'}}
      if(!(task.shared_with_borrowers||task.responsible_user_id===p.p_actor_user_id))return{data:null,error:{message:'not_participant'}}
      const revision=++task.revision;task.status='submitted';task.linked_document_id=doc.id;doc.status='uploaded'
      history.push({task_id:task.id,from_status:'in_progress',to_status:'submitted'})
      const result={to:'submitted',revision,document_id:doc.id};events.push({event_type:'task.submitted',idempotency_key:p.p_idempotency_key,request_hash:p.p_request_hash,source_record_id:task.id,result},{event_type:'notification.queued',idempotency_key:`intent:${p.p_idempotency_key}`,metadata:{intent:'borrower_document_submitted'}})
      return{data:{ok:true,deduped:false,task_id:task.id,document_id:doc.id,to:'submitted',revision},error:null}
    }
    return{data:null,error:{message:'unknown_rpc'}}
  }
  return {tasks,docs,history,events,from:(t)=>builder(rows(t)),rpc}
}
const input=(o={})=>({organization_id:'org',loan_file_id:'f',task_type:'document_request',title:'Upload',responsible_user_id:'b1',shared_with_borrowers:false,required_document_id:'d1',...o})
const create=async(db,key='create-reg',o={})=>createTaskRepo({db}).createTask({actor:lo,idempotencyKey:key,requestHash:`h-${key}`,input:input(o)})
async function progress(db,repo,id){let t=db.tasks.get(id);await repo.transition({task:{...t},action:'view',actor:b1,expectedRevision:t.revision,idempotencyKey:`view-${id}`,requestHash:`vh-${id}`});t=db.tasks.get(id);await repo.transition({task:{...t},action:'begin',actor:b1,expectedRevision:t.revision,idempotencyKey:`begin-${id}`,requestHash:`bh-${id}`});return db.tasks.get(id)}

test('valid transition bumps revision and appends one history/event',async()=>{const db=dbFake(),repo=createTaskRepo({db}),c=await create(db);const before=[db.history.length,db.events.length];const r=await repo.transition({task:{...db.tasks.get(c.task_id)},action:'view',actor:b1,expectedRevision:1,idempotencyKey:'valid-view',requestHash:'vv'});assert.equal(r.revision,2);assert.equal(db.history.length,before[0]+1);assert.equal(db.events.length,before[1]+1)})
test('invalid transition produces zero writes',async()=>{const db=dbFake(),repo=createTaskRepo({db}),c=await create(db);const before=[db.history.length,db.events.length];const r=await repo.transition({task:{...db.tasks.get(c.task_id)},action:'accept',actor:lo,expectedRevision:1,idempotencyKey:'invalid-accept',requestHash:'ia'});assert.equal(r.error,'invalid_transition');assert.deepEqual([db.history.length,db.events.length],before)})
test('borrower cannot accept a review task',async()=>{const db=dbFake(),repo=createTaskRepo({db}),c=await create(db);const t={...db.tasks.get(c.task_id),status:'team_review'};const r=await repo.transition({task:t,action:'accept',actor:b1,expectedRevision:t.revision,idempotencyKey:'borrower-accept',requestHash:'ba'});assert.equal(r.error,'forbidden_action')})
test('transport failure maps to persist_failed',async()=>{const db=dbFake({throwRpc:true}),repo=createTaskRepo({db});const r=await repo.createTask({actor:lo,idempotencyKey:'transport-create',requestHash:'tc',input:input()});assert.equal(r.error,'persist_failed')})
test('borrower scrub removes internal task fields',()=>{const row=scrubTaskForBorrower({id:'t',status:'rejected',revision:2,title:'x',internal_requirement:'secret',responsible_user_id:'b1',metadata:{x:1},borrower_visible_status_reason:'Page 6'});assert.equal(row.internal_requirement,undefined);assert.equal(row.responsible_user_id,undefined);assert.equal(row.metadata,undefined);assert.equal(row.borrower_visible_status_reason,'Page 6')})
test('AI and partner create are forbidden',async()=>{const db=dbFake(),repo=createTaskRepo({db});assert.equal((await repo.createTask({actor:{type:'ai'},idempotencyKey:'ai-create-reg',requestHash:'ai',input:input()})).error,'ai_forbidden');assert.equal((await repo.createTask({actor:{type:'realtor'},idempotencyKey:'realtor-create-reg',requestHash:'r',input:input()})).error,'forbidden_role')})
test('AI transition is forbidden with zero writes',async()=>{const db=dbFake(),repo=createTaskRepo({db}),c=await create(db);const before=db.events.length;const r=await repo.transition({task:{...db.tasks.get(c.task_id)},action:'view',actor:{type:'ai'},expectedRevision:1,idempotencyKey:'ai-view-reg',requestHash:'aiv'});assert.equal(r.error,'ai_forbidden');assert.equal(db.events.length,before)})
test('same create key/hash returns original; different hash conflicts',async()=>{const db=dbFake(),repo=createTaskRepo({db});const args={actor:lo,idempotencyKey:'dupe-create-reg',requestHash:'same',input:input()};const a=await repo.createTask(args),b=await repo.createTask(args),c=await repo.createTask({...args,requestHash:'other'});assert.equal(b.task_id,a.task_id);assert.equal(b.status,'assigned');assert.equal(c.error,'idempotency_conflict');assert.equal(db.tasks.size,1)})
test('lost transition response retry with refreshed current row returns original result',async()=>{const db=dbFake(),repo=createTaskRepo({db}),c=await create(db);const first=await repo.transition({task:{...db.tasks.get(c.task_id)},action:'view',actor:b1,expectedRevision:1,idempotencyKey:'lost-view-reg',requestHash:'lv'});const refreshed={...db.tasks.get(c.task_id)};const retry=await repo.transition({task:refreshed,action:'view',actor:b1,expectedRevision:1,idempotencyKey:'lost-view-reg',requestHash:'lv'});assert.equal(retry.deduped,true);assert.equal(retry.from,first.from);assert.equal(retry.to,first.to);assert.equal(retry.revision,first.revision)})
test('same transition key with payload drift conflicts',async()=>{const db=dbFake(),repo=createTaskRepo({db}),c=await create(db);await repo.transition({task:{...db.tasks.get(c.task_id)},action:'view',actor:b1,expectedRevision:1,idempotencyKey:'transition-conflict-reg',requestHash:'one'});const r=await repo.transition({task:{...db.tasks.get(c.task_id)},action:'view',actor:b1,expectedRevision:1,idempotencyKey:'transition-conflict-reg',requestHash:'two'});assert.equal(r.error,'idempotency_conflict')})
test('stale writer produces zero history/event writes',async()=>{const db=dbFake(),repo=createTaskRepo({db}),c=await create(db);const snap={...db.tasks.get(c.task_id)};await repo.transition({task:{...snap},action:'view',actor:b1,expectedRevision:1,idempotencyKey:'winner-reg',requestHash:'w'});const before=[db.history.length,db.events.length];const r=await repo.transition({task:{...db.tasks.get(c.task_id)},action:'begin',actor:b1,expectedRevision:1,idempotencyKey:'loser-reg',requestHash:'l'});assert.equal(r.error,'stale_task');assert.deepEqual([db.history.length,db.events.length],before)})
test('reject intent and reason are written once and cleared on correction begin',async()=>{const db=dbFake(),repo=createTaskRepo({db}),c=await create(db);let t=await progress(db,repo,c.task_id);await repo.transition({task:{...t},action:'submit',actor:b1,expectedRevision:t.revision,idempotencyKey:'submit-reg',requestHash:'s'});t=db.tasks.get(c.task_id);await repo.transition({task:{...t},action:'reject',actor:lo,borrowerVisibleReason:'Blurry',expectedRevision:t.revision,idempotencyKey:'reject-reg',requestHash:'r'});assert.equal(db.tasks.get(c.task_id).borrower_visible_status_reason,'Blurry');assert.equal(db.events.filter((e)=>e.idempotency_key==='intent:reject-reg').length,1);t=db.tasks.get(c.task_id);await repo.transition({task:{...t},action:'begin',actor:b1,expectedRevision:t.revision,idempotencyKey:'correct-reg',requestHash:'c'});assert.equal(db.tasks.get(c.task_id).borrower_visible_status_reason,null)})
test('shared/specific/internal visibility remains strict',()=>{const repo=createTaskRepo({db:dbFake()});assert.equal(repo.borrowerCanSeeTask({responsible_party_type:'borrower',shared_with_borrowers:true,responsible_user_id:null},'b2'),true);assert.equal(repo.borrowerCanSeeTask({responsible_party_type:'borrower',shared_with_borrowers:false,responsible_user_id:'b1'},'b2'),false);assert.equal(repo.borrowerCanSeeTask({responsible_party_type:'loan_team',shared_with_borrowers:true},'b1'),false)})
test('cross-organization transition and finalize fail without mutation',async()=>{const db=dbFake(),repo=createTaskRepo({db}),c=await create(db),t=await progress(db,repo,c.task_id);const before=[db.history.length,db.events.length,db.docs.get('d1').status];let out=await db.rpc('ourmtg_task_transition',{p_task_id:c.task_id,p_action:'submit',p_expected_revision:t.revision,p_actor_type:'borrower',p_actor_id:'b1',p_organization_id:'other',p_idempotency_key:'xorg-tr-reg',p_request_hash:'x'});assert.equal(out.error.message,'loan_org_mismatch');out=await db.rpc('ourmtg_document_finalize_submit',{p_task_id:c.task_id,p_document_id:'d1',p_expected_revision:t.revision,p_actor_type:'borrower',p_actor_user_id:'b1',p_organization_id:'other',p_idempotency_key:'xorg-fin-reg',p_request_hash:'xf'});assert.equal(out.error.message,'loan_org_mismatch');assert.deepEqual([db.history.length,db.events.length,db.docs.get('d1').status],before)})
test('terminal task cannot be finalized',async()=>{const db=dbFake(),repo=createTaskRepo({db}),c=await create(db);db.tasks.get(c.task_id).status='completed';const r=await repo.finalizeDocumentSubmit({documentId:'d1',task:{...db.tasks.get(c.task_id)},actor:b1,expectedRevision:1,idempotencyKey:'terminal-fin-reg',requestHash:'tf'});assert.equal(r.error,'invalid_transition');assert.equal(db.docs.get('d1').status,'requested')})
