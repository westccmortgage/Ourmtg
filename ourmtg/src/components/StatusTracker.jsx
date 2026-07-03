// The 7-step tracker, merged-concept style: seven ruled segments, display numerals,
// the current stage carrying its own color (--stage). Accepts the server's computed
// `steps` array (from portal-status) or derives from a stage key.
import { STAGE_STEPS, STAGE_LABEL, STAGE_COLOR } from '../lib/pipeline'

export default function StatusTracker({ steps, stage }) {
  const resolved = steps && steps.length
    ? steps
    : STAGE_STEPS.map((key, i) => {
        const currentIdx = STAGE_STEPS.indexOf(stage)
        return { key, label: STAGE_LABEL[key], done: i < currentIdx, current: key === stage }
      })
  return (
    <div className="tracker" role="list" aria-label="Loan progress">
      {resolved.map((s, i) => (
        <div
          key={s.key}
          className={`step ${s.done ? 'done' : ''} ${s.current ? 'current' : ''}`}
          style={s.current ? { '--stage': STAGE_COLOR[s.key] } : undefined}
          role="listitem"
          aria-current={s.current ? 'step' : undefined}
        >
          <span className="num">{i + 1}</span>
          <span className="label">{s.label}</span>
        </div>
      ))}
    </div>
  )
}
