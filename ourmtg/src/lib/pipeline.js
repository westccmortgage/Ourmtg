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

// Each stage owns one of the product's only colors (merged-concept rule: the UI is
// monochrome; color belongs to the stage and the stamp). Values are CSS vars from
// styles.css so themes stay centralized.
export const STAGE_COLOR = {
  lead: 'var(--st-lead)',
  preapproval: 'var(--st-preapproval)',
  processing: 'var(--st-processing)',
  underwriting: 'var(--st-underwriting)',
  conditional: 'var(--st-conditional)',
  ctc: 'var(--st-ctc)',
  funded: 'var(--st-funded)',
}

export function stepIndex(stage) {
  const i = STAGE_STEPS.indexOf(stage)
  return i < 0 ? 0 : i
}
