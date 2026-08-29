import { useMemo } from 'react'
import { PLATFORM_META, Post } from '../types'
import { fmtDateTime, timeAgo, timeUntil } from '../utils'

interface Props {
  posts: Post[]
  onOpen(p: Post): void
}

const DAY = 86_400_000
const STALE_DRAFT_DAYS = 14

function StatTile({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className={warn ? 'stat-value stat-warn' : 'stat-value'}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

interface Attention {
  post: Post
  reason: string
}

export function Dashboard({ posts, onOpen }: Props) {
  const s = useMemo(() => {
    const now = Date.now()
    const at = (iso?: string) => (iso ? new Date(iso).getTime() : NaN)

    const scheduled = posts.filter(p => p.status === 'scheduled')
    const upcoming = scheduled
      .filter(p => p.scheduledFor && at(p.scheduledFor) > now)
      .sort((a, b) => a.scheduledFor!.localeCompare(b.scheduledFor!))
    const overdue = scheduled
      .filter(p => p.scheduledFor && at(p.scheduledFor) <= now)
      .sort((a, b) => a.scheduledFor!.localeCompare(b.scheduledFor!))
    const unscheduled = scheduled.filter(p => !p.scheduledFor)
    const drafts = posts.filter(p => p.status === 'draft')
    const ideas = posts.filter(p => p.status === 'idea')
    const canceled = posts.filter(p => p.status === 'canceled')
    const posted = posts
      .filter(p => p.status === 'posted' && p.postedAt)
      .sort((a, b) => b.postedAt!.localeCompare(a.postedAt!))
    const posted30 = posted.filter(p => now - at(p.postedAt) < 30 * DAY)

    let avgGapDays: number | null = null
    const recentTimes = posted
      .filter(p => now - at(p.postedAt) < 90 * DAY)
      .map(p => at(p.postedAt))
      .sort((a, b) => a - b)
    if (recentTimes.length >= 2) {
      const gaps = recentTimes.slice(1).map((t, i) => t - recentTimes[i])
      avgGapDays = gaps.reduce((sum, g) => sum + g, 0) / gaps.length / DAY
    }

    const staleDrafts = drafts.filter(p => now - at(p.updatedAt) > STALE_DRAFT_DAYS * DAY)

    const attention: Attention[] = [
      ...overdue.map(post => ({ post, reason: `was due ${timeAgo(post.scheduledFor!)}` })),
      ...unscheduled.map(post => ({ post, reason: 'scheduled but has no date' })),
      ...staleDrafts.map(post => ({ post, reason: `draft untouched for ${timeAgo(post.updatedAt).replace(' ago', '')}` })),
    ]

    return { upcoming, overdue, drafts, ideas, canceled, posted, posted30, avgGapDays, attention }
  }, [posts])

  const lastPost = s.posted[0]
  const nextPost = s.upcoming[0]

  if (posts.length === 0) {
    return (
      <div className="empty-hero">
        <h2>Nothing here yet</h2>
        <p>
          Create a post from <strong>+ New post</strong> or import your history in <strong>Posts</strong>, and this
          dashboard fills in.
        </p>
      </div>
    )
  }

  return (
    <div className="insights">
      <div className="kpi-row">
        <StatTile label="Upcoming" value={String(s.upcoming.length)} sub="scheduled with a future date" />
        <StatTile
          label="Overdue"
          value={String(s.overdue.length)}
          sub={s.overdue.length > 0 ? 'past their scheduled time' : 'nothing missed'}
          warn={s.overdue.length > 0}
        />
        <StatTile label="Drafts" value={String(s.drafts.length)} sub="in progress" />
        <StatTile label="Ideas" value={String(s.ideas.length)} sub="unplanned" />
        <StatTile label="Canceled" value={String(s.canceled.length)} sub="discarded or denied" />
      </div>

      <div className="kpi-row">
        <StatTile
          label="Last post"
          value={lastPost ? timeAgo(lastPost.postedAt!) : '—'}
          sub={lastPost ? lastPost.title || undefined : 'nothing posted yet'}
        />
        <StatTile
          label="Next post"
          value={nextPost ? timeUntil(nextPost.scheduledFor!) : '—'}
          sub={nextPost ? nextPost.title || undefined : 'nothing scheduled'}
          warn={!nextPost}
        />
        <StatTile label="Posted, last 30 days" value={String(s.posted30.length)} />
        <StatTile
          label="Avg gap between posts"
          value={s.avgGapDays !== null ? `${s.avgGapDays.toFixed(1)}d` : '—'}
          sub="last 90 days"
        />
      </div>

      <div className="charts-grid">
        <section className="chart-card">
          <header className="chart-head">
            <div>
              <h3>Up next</h3>
              <p className="chart-sub">The next scheduled posts</p>
            </div>
          </header>
          {s.upcoming.length === 0 ? (
            <p className="empty">Nothing scheduled — the calendar is wide open.</p>
          ) : (
            <ul className="dash-list">
              {s.upcoming.slice(0, 5).map(p => (
                <li key={p.id} onClick={() => onOpen(p)}>
                  <div className="dash-main">
                    <span className="dash-title">{p.title || p.body.slice(0, 50) || 'Untitled'}</span>
                    <span className="dash-meta">
                      {p.platforms.map(pl => (
                        <span key={pl} className="chip platform" style={{ background: PLATFORM_META[pl].color }}>
                          {PLATFORM_META[pl].short}
                        </span>
                      ))}
                      {p.recurrence && <span title="Repeats">↻</span>}
                    </span>
                  </div>
                  <div className="dash-when">
                    <strong>{timeUntil(p.scheduledFor!)}</strong>
                    <small>{fmtDateTime(p.scheduledFor)}</small>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="chart-card">
          <header className="chart-head">
            <div>
              <h3>Needs attention</h3>
              <p className="chart-sub">Overdue, unscheduled, or going stale</p>
            </div>
          </header>
          {s.attention.length === 0 ? (
            <p className="empty">All clear — nothing is stuck.</p>
          ) : (
            <ul className="dash-list">
              {s.attention.slice(0, 6).map(({ post, reason }) => (
                <li key={post.id} onClick={() => onOpen(post)}>
                  <div className="dash-main">
                    <span className="dash-title">{post.title || post.body.slice(0, 50) || 'Untitled'}</span>
                    <span className="dash-reason">{reason}</span>
                  </div>
                  <span className="dash-fix">Fix →</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
