// Small presentational primitives shared across screens.
export function Spinner() {
  return <div className="loading"><div className="spinner" /></div>
}

export function Alert({ kind = 'info', children }) {
  if (!children) return null
  return <div className={`alert alert-${kind}`}>{children}</div>
}

const CHIP_KIND = {
  missing: 'gray', requested: 'amber', uploaded: 'amber',
  accepted: 'green', rejected: 'red',
  open: 'amber', submitted: 'amber', cleared: 'green',
}
const CHIP_TEXT = {
  missing: 'Not started', requested: 'Requested', uploaded: 'Under review',
  accepted: 'Accepted', rejected: 'Needs another', open: 'Action needed',
  submitted: 'Under review', cleared: 'Cleared',
}
export function StatusChip({ status }) {
  return <span className={`chip ${CHIP_KIND[status] || 'gray'}`}>{CHIP_TEXT[status] || status}</span>
}

export function Empty({ children }) {
  return <p className="muted center" style={{ padding: '20px 0' }}>{children}</p>
}
