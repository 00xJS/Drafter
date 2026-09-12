import { REFINE_META, RefineMode } from '../../ai'
import { AiBusy, SetForm } from '../../taskform'

/** A proposed rewrite of the description, waiting for the user to accept or discard it. */
export interface RefineProposal {
  mode: RefineMode
  text: string
}

interface Props {
  description: string
  set: SetForm
  aiBusy: AiBusy
  onRefine(mode: RefineMode): void
  proposal: RefineProposal | null
  setProposal(p: RefineProposal | null): void
}

/** The description, its ✨ rewrite buttons, and a rewrite waiting to be taken or left. */
export function DescriptionField({ description, set, aiBusy, onRefine, proposal, setProposal }: Props) {
  return (
    <label className="field">
      <span>Description</span>
      <textarea rows={5} value={description} onChange={e => set({ description: e.target.value })} placeholder="What needs to happen, and why? Links, measurements, context…" />
      <div className="ai-row desc-ai">
        {(Object.keys(REFINE_META) as RefineMode[]).map(mode => (
          <button
            key={mode}
            type="button"
            className="btn subtle"
            title={REFINE_META[mode].hint}
            disabled={!description.trim() || aiBusy !== null}
            onClick={e => {
              e.preventDefault()
              onRefine(mode)
            }}
          >
            {aiBusy === mode ? REFINE_META[mode].busy : REFINE_META[mode].label}
          </button>
        ))}
      </div>
      {proposal && (
        <div className="ai-proposal" onClick={e => e.preventDefault()}>
          <div className="ai-proposal-head">
            <strong>{REFINE_META[proposal.mode].label.replace('✨ ', '')} suggestion</strong>
            <small>Review, then replace or keep yours</small>
          </div>
          <textarea rows={Math.min(12, Math.max(4, proposal.text.split('\n').length + 1))} value={proposal.text} onChange={e => setProposal({ ...proposal, text: e.target.value })} />
          <div className="ai-row">
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                set({ description: proposal.text })
                setProposal(null)
              }}
            >
              Replace description
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                set(f => ({ description: f.description.trim() ? `${f.description.trimEnd()}\n\n${proposal.text}` : proposal.text }))
                setProposal(null)
              }}
            >
              Append below
            </button>
            <button type="button" className="btn subtle" onClick={() => setProposal(null)}>
              Discard
            </button>
          </div>
        </div>
      )}
    </label>
  )
}
