// The 7-step loan status bar. Accepts either the server's computed `steps` array
// (from portal-status) or falls back to deriving from a stage + STAGE_STEPS.
import { STAGE_STEPS, STAGE_LABEL } from '../lib/pipeline'

export default function StatusTracker({ steps, stage }) {
  const resolved = steps && steps.length
    ? steps
    : STAGE_STEPS.map((key, i) => {
        const currentIdx = STAGE_STEPS.indexOf(stage)
        return { key, label: STAGE_LABEL[key], done: i < currentIdx, current: key === stage }
      })
  return (
    <div className="tracker" role="list" aria-label="Loan progress">
      {resolved.map((s) => (
        <div key={s.key} className={`step ${s.done ? 'done' : ''} ${s.current ? 'current' : ''}`} role="listitem">
          <div className="dot">{s.done ? '✓' : ''}</div>
          <div className="label">{s.label}</div>
        </div>
      ))}
    </div>
  )
}
