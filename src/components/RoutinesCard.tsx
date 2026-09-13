import { useState } from 'react'
import { ROUTINE_WHENS, Routine, RoutineWhen } from '../types'
import { newerStamp } from '../itemops'
import { uid } from '../utils'
import { isStepDone, progressOn, stepsFromText, stepsToText, toggleStep, whichToShow } from '../routines'
import { ConfirmButton } from './ConfirmButton'

const WHEN_LABEL: Record<RoutineWhen, string> = { morning: 'Morning', evening: 'Evening', anytime: 'Anytime' }

/**
 * Today's routines: the checklists for this time of day, each step a checkbox.
 * Like habits, routines are personal and their ticks live on the record, so a
 * tick is one small write and the list is managed in place — add, edit, delete
 * — rather than on a tab of its own. `hour` is live from the parent, so a
 * phone that slept through the night wakes to the morning list; it is held
 * still only while an edit is open, so the list cannot shuffle under it at noon.
 */
export function RoutinesCard({ routines, today, hour, onSave, onDelete }: { routines: Routine[]; today: string; hour: number; onSave(r: Routine): void; onDelete(id: string): void }) {
  const [editing, setEditing] = useState<string | null>(null) // routine id, or 'new'
  const [editHour, setEditHour] = useState(hour) // the hour the open edit began in
  const [name, setName] = useState('')
  const [when, setWhen] = useState<RoutineWhen>('anytime')
  const [stepsText, setStepsText] = useState('')
  const [showAll, setShowAll] = useState(false)

  const nowSet = whichToShow(editing !== null ? editHour : hour)
  // an open edit stays visible even when its hour has passed
  const visible = showAll ? routines : routines.filter(r => nowSet.has(r.when) || r.id === editing)
  const hiddenCount = routines.length - visible.length

  const openNew = () => {
    setEditing('new')
    setEditHour(hour)
    setName('')
    setWhen(hour < 12 ? 'morning' : hour >= 17 ? 'evening' : 'anytime')
    setStepsText('')
  }
  const openEdit = (r: Routine) => {
    setEditing(r.id)
    setEditHour(hour)
    setName(r.name)
    setWhen(r.when)
    setStepsText(stepsToText(r.steps))
  }
  const close = () => setEditing(null)

  const canSave = !!name.trim() && stepsText.split('\n').some(l => l.trim())

  const save = () => {
    if (!canSave) return
    const n = name.trim()
    const stamp = new Date().toISOString()
    if (editing === 'new') {
      onSave({
        kind: 'routine',
        id: uid(),
        name: n,
        when,
        steps: stepsFromText(stepsText),
        ticks: [],
        order: routines.length,
        createdAt: stamp,
        updatedAt: stamp,
      })
    } else {
      const r = routines.find(x => x.id === editing)
      if (r) onSave({ ...r, name: n, when, steps: stepsFromText(stepsText, r.steps), updatedAt: newerStamp(r.updatedAt) })
    }
    close()
  }

  const form = { name, setName, when, setWhen, stepsText, setStepsText, save, close, canSave }

  return (
    <section className="chart-card routines-card">
      <header className="chart-head">
        <div>
          <h3>Routines</h3>
          <p className="chart-sub">Morning and evening checklists — fresh every day</p>
        </div>
        {editing !== 'new' && (
          <button type="button" className="btn subtle" onClick={openNew}>
            + Add
          </button>
        )}
      </header>

      {editing === 'new' && <RoutineForm {...form} isNew />}

      {routines.length === 0 && editing !== 'new' ? (
        <p className="empty">No routines yet. Add one — a morning start, a wind-down before bed.</p>
      ) : (
        <>
          {visible.length === 0 && editing !== 'new' && <p className="routine-hidden">Nothing for this time of day.</p>}
          <ul className="routine-list">
            {visible.map(r =>
              editing === r.id ? (
                <li key={r.id}>
                  <RoutineForm
                    {...form}
                    isNew={false}
                    onDelete={() => {
                      onDelete(r.id)
                      close()
                    }}
                  />
                </li>
              ) : (
                <RoutineRow key={r.id} routine={r} today={today} onSave={onSave} onEdit={openEdit} />
              ),
            )}
          </ul>
          {(hiddenCount > 0 || showAll) && (
            <button type="button" className="btn subtle routine-showall" onClick={() => setShowAll(v => !v)}>
              {showAll ? 'Show now' : `Show all (${hiddenCount} more)`}
            </button>
          )}
        </>
      )}
    </section>
  )
}

/**
 * One routine as its day's checklist: the name, when it runs and how far
 * through it you are, then each step as a checkbox. With `onEdit` the name
 * opens the routine for editing (Today's card); without it the name is only a
 * label (Shut down, which ticks but never edits).
 */
function RoutineRow({ routine: r, today, onSave, onEdit }: { routine: Routine; today: string; onSave(r: Routine): void; onEdit?(r: Routine): void }) {
  const { done, total } = progressOn(r, today)
  const label = (
    <>
      <span>{r.name}</span>
      <span className="routine-when">{WHEN_LABEL[r.when]}</span>
    </>
  )
  return (
    <li className={'routine-row' + (total > 0 && done === total ? ' complete' : '')}>
      <div className="routine-head">
        {onEdit ? (
          <button type="button" className="routine-name" onClick={() => onEdit(r)} title="Edit routine">
            {label}
          </button>
        ) : (
          <span className="routine-name">{label}</span>
        )}
        <span className="routine-progress">
          {done}/{total}
        </span>
      </div>
      <ul className="routine-steps">
        {r.steps.map(s => {
          const ticked = isStepDone(r, today, s.id)
          return (
            <li key={s.id}>
              <label className="routine-step">
                <input type="checkbox" className="tcheck" checked={ticked} onChange={() => onSave(toggleStep(r, today, s.id))} />
                <span className={ticked ? 'done' : ''}>{s.text}</span>
              </label>
            </li>
          )
        })}
      </ul>
    </li>
  )
}

/**
 * Routines to tick, and nothing else: the rows of Today's card without its
 * add, edit and time-of-day filtering. Shut down uses it for the evening
 * routine, so a tick there is the same write as a tick on the card.
 */
export function RoutineTicks({ routines, today, onSave }: { routines: Routine[]; today: string; onSave(r: Routine): void }) {
  return (
    <ul className="routine-list">
      {routines.map(r => (
        <RoutineRow key={r.id} routine={r} today={today} onSave={onSave} />
      ))}
    </ul>
  )
}

function RoutineForm({
  name,
  setName,
  when,
  setWhen,
  stepsText,
  setStepsText,
  save,
  close,
  canSave,
  isNew,
  onDelete,
}: {
  name: string
  setName(s: string): void
  when: RoutineWhen
  setWhen(w: RoutineWhen): void
  stepsText: string
  setStepsText(s: string): void
  save(): void
  close(): void
  canSave: boolean
  isNew: boolean
  onDelete?(): void
}) {
  return (
    <div className="routine-form">
      <input
        className="routine-name-input"
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            save()
          }
          if (e.key === 'Escape') close()
        }}
        placeholder="New routine — e.g. Morning start"
        aria-label="Routine name"
      />
      <div className="segmented" role="group" aria-label="When">
        {ROUTINE_WHENS.map(w => (
          <button key={w} type="button" className={'seg' + (when === w ? ' on' : '')} onClick={() => setWhen(w)} aria-pressed={when === w}>
            {WHEN_LABEL[w]}
          </button>
        ))}
      </div>
      {/* Enter adds a line here, never saves — a step list is typed one per line */}
      <textarea
        className="routine-steps-input"
        rows={4}
        value={stepsText}
        onChange={e => setStepsText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') close()
        }}
        placeholder="One step per line"
        aria-label="Steps, one per line"
      />
      <div className="routine-form-actions">
        <button type="button" className="btn primary" onClick={save} disabled={!canSave}>
          {isNew ? 'Add routine' : 'Save'}
        </button>
        <button type="button" className="btn subtle" onClick={close}>
          Cancel
        </button>
        {onDelete && (
          <ConfirmButton className="btn subtle danger routine-delete" onConfirm={onDelete}>
            Delete
          </ConfirmButton>
        )}
      </div>
    </div>
  )
}
