import { ConfirmButton } from '../ConfirmButton'
import type { SettingsCtx } from './context'

/** Data → Project templates: the ones saved from projects, each removable. Hidden until there is one. */
export function Templates({ store }: SettingsCtx) {
  if (store.templates.length === 0) return null
  return (
    <section className="settings-section g-data">
      <h3>Project templates</h3>
      <p className="field-hint">Saved from your projects. Pick one when creating a new project.</p>
      <ul className="cal-sources">
        {store.templates.map(t => (
          <li key={t.id} className="cal-source">
            <span className="pdot" style={{ background: t.color }} />
            <span className="cal-source-name">
              {t.emoji ? `${t.emoji} ` : ''}
              {t.name} <small>· {t.tasks.length} tasks{t.milestones?.length ? `, ${t.milestones.length} milestones` : ''}</small>
            </span>
            <ConfirmButton className="btn subtle danger" confirmLabel="Sure?" onConfirm={() => store.remove(t.id)}>
              Remove
            </ConfirmButton>
          </li>
        ))}
      </ul>
    </section>
  )
}
