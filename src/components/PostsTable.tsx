import { useMemo, useRef, useState } from 'react'
import { Platform, PLATFORMS, PLATFORM_META, Post, Status, STATUSES, STATUS_META, engagement } from '../types'
import { Store } from '../store'
import { postsFromCSV } from '../importers'
import { migrateStored, STORAGE_VERSION } from '../schema'
import { excerpt, fmtDateTime, fmtNum } from '../utils'
import { useMediaQuery } from '../useMediaQuery'
import { ImportArchiveDialog } from './ImportArchiveDialog'

interface Props {
  store: Store
  onOpen(p: Post): void
  onNew(preset?: Partial<Post>): void
  onDelete(p: Post): void
}

type SortKey = 'date' | 'engagement'

const postWhen = (p: Post) => p.postedAt ?? p.scheduledFor ?? p.updatedAt

export function PostsTable({ store, onOpen, onNew, onDelete }: Props) {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<Status | 'all'>('all')
  const [platform, setPlatform] = useState<Platform | 'all'>('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'date', dir: -1 })
  const [notice, setNotice] = useState('')
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const jsonInput = useRef<HTMLInputElement>(null)
  const csvInput = useRef<HTMLInputElement>(null)
  const isNarrow = useMediaQuery('(max-width: 640px)')

  const toggleSort = (key: SortKey) =>
    setSort(cur => (cur.key === key ? { key, dir: cur.dir === -1 ? 1 : -1 } : { key, dir: -1 }))

  const sortArrow = (key: SortKey) => (sort.key === key ? (sort.dir === -1 ? ' ▼' : ' ▲') : '')

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return store.posts
      .filter(p => status === 'all' || p.status === status)
      .filter(p => platform === 'all' || p.platforms.includes(platform))
      .filter(p => !needle || (p.title + ' ' + p.body + ' ' + p.tags.join(' ')).toLowerCase().includes(needle))
      .sort((a, b) => {
        if (sort.key === 'date') return sort.dir * postWhen(a).localeCompare(postWhen(b))
        return sort.dir * (engagement(a) - engagement(b))
      })
  }, [store.posts, q, status, platform, sort])

  const visible = showAll ? filtered : filtered.slice(0, 200)

  function exportJSON() {
    const payload = { version: STORAGE_VERSION, exportedAt: new Date().toISOString(), posts: store.allPosts }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `drafter-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function onJSONFile(file: File) {
    try {
      const migrated = migrateStored(JSON.parse(await file.text()))
      if (!migrated) throw new Error('expected a Drafter backup (array of posts or {version, posts})')
      const s = store.importPosts(migrated)
      setNotice(`JSON import: ${s.added} new, ${s.updated} updated, ${s.unchanged} unchanged.`)
    } catch (e) {
      setNotice(`JSON import failed: ${(e as Error).message}`)
    }
  }

  async function onCSVFile(file: File) {
    try {
      const posts = postsFromCSV(await file.text())
      if (posts.length === 0) throw new Error('no rows recognized — expected headers like date, platform, text, likes')
      const s = store.importPosts(posts)
      setNotice(`CSV import: ${s.added} new, ${s.updated} updated, ${s.unchanged} unchanged.`)
    } catch (e) {
      setNotice(`CSV import failed: ${(e as Error).message}`)
    }
  }

  return (
    <div className="posts-view">
      <div className="toolbar">
        <input className="search" placeholder="Search posts…" value={q} onChange={e => setQ(e.target.value)} />
        <select value={status} onChange={e => setStatus(e.target.value as Status | 'all')}>
          <option value="all">All statuses</option>
          {STATUSES.map(s => (
            <option key={s} value={s}>
              {STATUS_META[s].label}
            </option>
          ))}
        </select>
        <select value={platform} onChange={e => setPlatform(e.target.value as Platform | 'all')}>
          <option value="all">All platforms</option>
          {PLATFORMS.map(pl => (
            <option key={pl} value={pl}>
              {PLATFORM_META[pl].label}
            </option>
          ))}
        </select>
        {isNarrow && (
          <span className="segmented sort-seg">
            <button className={sort.key === 'date' ? 'seg on' : 'seg'} onClick={() => toggleSort('date')}>
              Date{sortArrow('date')}
            </button>
            <button className={sort.key === 'engagement' ? 'seg on' : 'seg'} onClick={() => toggleSort('engagement')}>
              Eng{sortArrow('engagement')}
            </button>
          </span>
        )}
        <span className="spacer" />
        {isNarrow ? (
          <details className="action-menu">
            <summary className="btn">Import / Export ▾</summary>
            <div className="action-menu-items">
              <button className="btn" onClick={() => onNew({ status: 'posted', postedAt: new Date().toISOString() })}>
                Log past post
              </button>
              <button className="btn" onClick={() => setArchiveOpen(true)}>
                Import archive
              </button>
              <button className="btn" onClick={() => csvInput.current?.click()}>
                Import CSV
              </button>
              <button className="btn" onClick={() => jsonInput.current?.click()}>
                Import JSON
              </button>
              <button className="btn" onClick={exportJSON}>
                Export JSON
              </button>
            </div>
          </details>
        ) : (
          <>
            <button className="btn" onClick={() => onNew({ status: 'posted', postedAt: new Date().toISOString() })}>
              Log past post
            </button>
            <button className="btn" onClick={() => setArchiveOpen(true)}>
              Import archive
            </button>
            <button className="btn" onClick={() => csvInput.current?.click()}>
              CSV
            </button>
            <button className="btn" onClick={() => jsonInput.current?.click()}>
              Import JSON
            </button>
            <button className="btn" onClick={exportJSON}>
              Export JSON
            </button>
          </>
        )}
        <input
          ref={csvInput}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) onCSVFile(f)
            e.target.value = ''
          }}
        />
        <input
          ref={jsonInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) onJSONFile(f)
            e.target.value = ''
          }}
        />
      </div>

      {notice && (
        <div className="notice">
          {notice}
          <button className="btn subtle" onClick={() => setNotice('')}>
            ✕
          </button>
        </div>
      )}

      {isNarrow ? (
        <ul className="mpost-list">
          {visible.map(p => (
            <li key={p.id} className="mpost" onClick={() => onOpen(p)}>
              <div className="mpost-top">
                <span className="row-title">{p.title || excerpt(p.body, 48) || 'Untitled'}</span>
                <span className="badge" style={{ background: STATUS_META[p.status].bg, color: STATUS_META[p.status].color }}>
                  {STATUS_META[p.status].label}
                </span>
              </div>
              {p.title && p.body && <div className="row-body">{excerpt(p.body, 90)}</div>}
              <div className="mpost-meta">
                <span className="chips">
                  {p.platforms.map(pl => (
                    <span key={pl} className="chip platform" style={{ background: PLATFORM_META[pl].color }}>
                      {PLATFORM_META[pl].short}
                    </span>
                  ))}
                </span>
                <span className="cell-date">{fmtDateTime(p.postedAt ?? p.scheduledFor) || '—'}</span>
                {p.status === 'posted' && <span className="card-eng">♥ {fmtNum(engagement(p))}</span>}
                <span className="spacer" />
                <button
                  className="btn subtle danger"
                  onClick={e => {
                    e.stopPropagation()
                    onDelete(p)
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
      <div className="table-scroll">
      <table className="posts-table">
        <thead>
          <tr>
            <th>Post</th>
            <th>Platforms</th>
            <th>Status</th>
            <th>
              <button className="th-sort" onClick={() => toggleSort('date')}>
                Date &amp; time{sortArrow('date')}
              </button>
            </th>
            <th className="num">
              <button className="th-sort" onClick={() => toggleSort('engagement')}>
                Engagement{sortArrow('engagement')}
              </button>
            </th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {visible.map(p => (
            <tr key={p.id} onClick={() => onOpen(p)}>
              <td>
                <div className="row-title">{p.title || excerpt(p.body, 48) || 'Untitled'}</div>
                {p.title && p.body && <div className="row-body">{excerpt(p.body, 70)}</div>}
              </td>
              <td>
                <span className="chips">
                  {p.platforms.map(pl => (
                    <span key={pl} className="chip platform" style={{ background: PLATFORM_META[pl].color }}>
                      {PLATFORM_META[pl].short}
                    </span>
                  ))}
                </span>
              </td>
              <td>
                <span className="badge" style={{ background: STATUS_META[p.status].bg, color: STATUS_META[p.status].color }}>
                  {STATUS_META[p.status].label}
                </span>
              </td>
              <td className="cell-date">{fmtDateTime(p.postedAt ?? p.scheduledFor) || '—'}</td>
              <td className="num">{p.status === 'posted' ? fmtNum(engagement(p)) : '—'}</td>
              <td>
                <button
                  className="btn subtle danger"
                  onClick={e => {
                    e.stopPropagation()
                    onDelete(p)
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      )}
      {filtered.length > visible.length && (
        <button className="btn show-all" onClick={() => setShowAll(true)}>
          Show all {filtered.length} posts
        </button>
      )}
      {filtered.length === 0 && <p className="empty">No posts match.</p>}

      {archiveOpen && <ImportArchiveDialog store={store} onClose={() => setArchiveOpen(false)} />}
    </div>
  )
}
