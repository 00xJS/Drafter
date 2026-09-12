import { useState } from 'react'
import { newerStamp } from '../../itemops'
import { getSupabase } from '../../supabase'
import { TaskVersion, versionNote, versionRows } from '../../taskform'
import { Task } from '../../types'
import { fmtDateTime } from '../../utils'

interface Props {
  task: Task
  getLatest(id: string): Task | undefined
  onCommit(t: Task): void
  onClose(): void
}

/** A saved task's earlier copies from posts_history, fetched the first time the list is opened; any one can be restored. */
export function VersionsPanel({ task, getLatest, onCommit, onClose }: Props) {
  const [versions, setVersions] = useState<TaskVersion[] | null>(null)
  const [versionsBusy, setVersionsBusy] = useState(false)

  async function loadVersions() {
    if (versions !== null || versionsBusy) return
    const sb = getSupabase()
    if (!sb) {
      setVersions([])
      return
    }
    setVersionsBusy(true)
    try {
      // '*' rather than a column list: `reason` only exists once v3.11 is applied,
      // and naming it would fail the whole query against an older database
      const { data, error } = await sb
        .from('posts_history')
        .select('*')
        .eq('id', task.id)
        .order('replaced_at', { ascending: false })
        .limit(20)
      if (error) throw error
      setVersions(versionRows(data))
    } catch {
      setVersions([])
    } finally {
      setVersionsBusy(false)
    }
  }

  function restoreVersion(v: Task) {
    const current = getLatest(task.id) ?? task
    onCommit({ ...v, id: current.id, updatedAt: newerStamp(current.updatedAt), ownerId: current.ownerId })
    onClose()
  }

  return (
    <details
      className="versions"
      onToggle={e => {
        if ((e.target as HTMLDetailsElement).open) void loadVersions()
      }}
    >
      <summary>Versions</summary>
      {versionsBusy && <p className="muted">Loading…</p>}
      {versions && versions.length === 0 && <p className="empty">No earlier versions yet.</p>}
      {versions && versions.length > 0 && (
        <ul className="versions-list">
          {versions.map((v, i) => (
            <li key={`${v.replaced_at}-${i}`}>
              <div className="dash-main">
                <span className="dash-title">{v.data.title || 'Untitled'}</span>
                <span className="dash-reason">
                  {versionNote(v)}
                  {fmtDateTime(v.replaced_at)}
                </span>
              </div>
              <button type="button" className="btn" onClick={() => restoreVersion(v.data)}>
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}
