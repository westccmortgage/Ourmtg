// Client mirror of the gateway's stage metadata (_lib/portal.mjs STAGE_META). Used for
// rendering the 7-step tracker and milestone chips. The server is authoritative and
// returns computed `steps`/`stage`; this exists for labels/colors the API doesn't send.

export const STAGE_STEPS = ['lead', 'preapproval', 'processing', 'underwriting', 'conditional', 'ctc', 'funded']

export const STAGE_LABEL = {
  lead: 'Application',
  preapproval: 'Pre-Approval',
  processing: 'Processing',
  underwriting: 'Underwriting',
  conditional: 'Conditional',
  ctc: 'Clear to Close',
  funded: 'Funded',
}

// Coarse milestone label shown to realtors (no financials).
export const MILESTONE_LABEL = {
  lead: 'Application started',
  preapproval: 'Pre-approved',
  processing: 'In processing',
  underwriting: 'In underwriting',
  conditional: 'In underwriting',
  ctc: 'Clear to close',
  funded: 'Funded',
}

export function stepIndex(stage) {
  const i = STAGE_STEPS.indexOf(stage)
  return i < 0 ? 0 : i
}
