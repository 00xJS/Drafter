import { CapturedFields } from '../../ai'
import { fmtDateTime } from '../../utils'

interface Props {
  proposal: CapturedFields
  /** The capture is still being parsed. */
  parsing: boolean
  onApply(): void
  onDismiss(): void
}

/** What a captured sentence would fill in, waiting to be applied or dismissed. */
export function CaptureProposal({ proposal: captureProposal, parsing, onApply, onDismiss }: Props) {
  return (
    <div className="ai-proposal" onClick={e => e.preventDefault()}>
      <div className="ai-proposal-head">
        <strong>Capture suggestion</strong>
        <small>{parsing ? 'Parsing…' : 'Review, then apply or dismiss'}</small>
      </div>
      <ul className="capture-fields">
        <li>
          <strong>Title</strong> {captureProposal.title}
        </li>
        {captureProposal.dueAt && (
          <li>
            <strong>Due</strong> {fmtDateTime(captureProposal.dueAt)}
          </li>
        )}
        {captureProposal.priority && (
          <li>
            <strong>Priority</strong> {captureProposal.priority}
          </li>
        )}
        {captureProposal.projectName && (
          <li>
            <strong>Project</strong> {captureProposal.projectName}
          </li>
        )}
        {captureProposal.peopleNames?.length ? (
          <li>
            <strong>People</strong> {captureProposal.peopleNames.join(', ')}
          </li>
        ) : null}
        {captureProposal.tags?.length ? (
          <li>
            <strong>Tags</strong> {captureProposal.tags.join(', ')}
          </li>
        ) : null}
        {captureProposal.recurrence && (
          <li>
            <strong>Repeat</strong> {captureProposal.recurrence}
          </li>
        )}
      </ul>
      <div className="ai-row">
        <button type="button" className="btn primary" onClick={onApply}>
          Apply
        </button>
        <button type="button" className="btn subtle" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  )
}
