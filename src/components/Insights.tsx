import { useMemo, useState } from 'react'
import { Metrics, Platform, PLATFORMS, PLATFORM_META, Post, engagement, impressions } from '../types'
import { fmtDate, fmtNum } from '../utils'
import { analyzeTopPosts } from '../ai'
import { ChartCard, ColumnChart, Datum, HBarChart, HeatRow, Heatmap } from './charts'

type RangeDays = 30 | 90 | 365 | 0

const RANGE_OPTIONS: { value: RangeDays; label: string; short: string }[] = [
  { value: 30, label: 'Last 30 days', short: 'prev 30d' },
  { value: 90, label: 'Last 90 days', short: 'prev 90d' },
  { value: 365, label: 'Last 12 months', short: 'prev 12mo' },
  { value: 0, label: 'All time', short: '' },
]

const DAY = 86_400_000
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const SLOT_LABELS = ['12–3a', '3–6a', '6–9a', '9a–12p', '12–3p', '3–6p', '6–9p', '9p–12a']
const PROVENANCE_TAGS = new Set(['imported', 'x-archive', 'ig-archive'])

function weekStart(t: number): Date {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d
}

interface Aggregates {
  count: number
  eng: number
  impr: number
  rate: number | null
  avg: number
}

function aggregate(posts: Post[]): Aggregates {
  const eng = posts.reduce((s, p) => s + engagement(p), 0)
  const impr = posts.reduce((s, p) => s + impressions(p), 0)
  return {
    count: posts.length,
    eng,
    impr,
    rate: impr > 0 ? (eng / impr) * 100 : null,
    avg: posts.length > 0 ? Math.round(eng / posts.length) : 0,
  }
}

function Delta({ cur, prev, periodLabel }: { cur: number; prev: number | null; periodLabel: string }) {
  if (prev === null || !periodLabel) return null
  if (prev === 0) return <div className="stat-delta neutral">— vs {periodLabel}</div>
  const pct = ((cur - prev) / prev) * 100
  const up = pct >= 0
  return (
    <div className={up ? 'stat-delta up' : 'stat-delta down'}>
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(0)}% vs {periodLabel}
    </div>
  )
}

function StatTile({
  label,
  value,
  sub,
  delta,
}: {
  label: string
  value: string
  sub?: string
  delta?: { cur: number; prev: number | null; periodLabel: string }
}) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {delta && <Delta {...delta} />}
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

export function Insights({ posts }: { posts: Post[] }) {
  const [range, setRange] = useState<RangeDays>(90)
  const [platformFilter, setPlatformFilter] = useState<Platform | 'all'>('all')
  const [excludeReplies, setExcludeReplies] = useState(true)
  const [analysis, setAnalysis] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')

  const allPosted = useMemo(
    () =>
      posts
        .filter(p => p.status === 'posted' && p.postedAt)
        .filter(p => !excludeReplies || !p.tags.includes('reply'))
        .filter(p => platformFilter === 'all' || p.platforms.includes(platformFilter))
        .sort((a, b) => a.postedAt!.localeCompare(b.postedAt!)),
    [posts, excludeReplies, platformFilter],
  )

  const posted = useMemo(() => {
    const cutoff = range === 0 ? 0 : Date.now() - range * DAY
    return allPosted.filter(p => new Date(p.postedAt!).getTime() >= cutoff)
  }, [allPosted, range])

  const prevPosted = useMemo(() => {
    if (range === 0) return null
    const from = Date.now() - 2 * range * DAY
    const to = Date.now() - range * DAY
    return allPosted.filter(p => {
      const t = new Date(p.postedAt!).getTime()
      return t >= from && t < to
    })
  }, [allPosted, range])

  const cur = useMemo(() => aggregate(posted), [posted])
  const prev = useMemo(() => (prevPosted ? aggregate(prevPosted) : null), [prevPosted])
  const periodLabel = RANGE_OPTIONS.find(o => o.value === range)?.short ?? ''

  const cadence = useMemo<{ data: Datum[]; unit: 'week' | 'month' }>(() => {
    if (posted.length === 0) return { data: [], unit: 'week' }
    const now = Date.now()
    const firstT = new Date(posted[0].postedAt!).getTime()
    const startT = range === 0 ? firstT : now - range * DAY

    const weeks: Date[] = []
    for (let d = weekStart(startT); d.getTime() <= now; d = new Date(d.getTime() + 7 * DAY)) weeks.push(d)

    if (weeks.length <= 20) {
      const counts = new Map<number, number>()
      for (const p of posted) {
        const k = weekStart(new Date(p.postedAt!).getTime()).getTime()
        counts.set(k, (counts.get(k) ?? 0) + 1)
      }
      return {
        unit: 'week',
        data: weeks.map(w => ({
          label: w.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
          value: counts.get(w.getTime()) ?? 0,
        })),
      }
    }

    // long ranges bucket by month so the axis stays readable
    const months: Date[] = []
    const s = new Date(startT)
    for (let d = new Date(s.getFullYear(), s.getMonth(), 1); d.getTime() <= now; d = new Date(d.getFullYear(), d.getMonth() + 1, 1))
      months.push(d)
    const counts = new Map<string, number>()
    for (const p of posted) {
      const d = new Date(p.postedAt!)
      counts.set(`${d.getFullYear()}-${d.getMonth()}`, (counts.get(`${d.getFullYear()}-${d.getMonth()}`) ?? 0) + 1)
    }
    const multiYear = new Set(months.map(m => m.getFullYear())).size > 1
    return {
      unit: 'month',
      data: months.map(m => ({
        label:
          m.toLocaleDateString(undefined, { month: 'short' }) + (multiYear ? ` ’${String(m.getFullYear()).slice(2)}` : ''),
        value: counts.get(`${m.getFullYear()}-${m.getMonth()}`) ?? 0,
      })),
    }
  }, [posted, range])

  const byPlatform = useMemo(() => {
    const map = new Map<Platform, { posts: number; likes: number; comments: number; shares: number; impressions: number }>()
    for (const p of posted) {
      // seed from the post's platforms so a platform with no metrics yet
      // (e.g. an Instagram archive) still shows up instead of vanishing
      for (const pl of p.platforms) {
        const acc = map.get(pl) ?? { posts: 0, likes: 0, comments: 0, shares: 0, impressions: 0 }
        acc.posts += 1
        const m: Metrics | undefined = p.metrics?.[pl]
        if (m) {
          acc.likes += m.likes ?? 0
          acc.comments += m.comments ?? 0
          acc.shares += m.shares ?? 0
          acc.impressions += m.impressions ?? 0
        }
        map.set(pl, acc)
      }
    }
    return [...map.entries()].sort(
      (a, b) => b[1].likes + b[1].comments + b[1].shares - (a[1].likes + a[1].comments + a[1].shares),
    )
  }, [posted])

  const heatRows = useMemo<HeatRow[]>(() => {
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 8 }, () => ({ count: 0, eng: 0 })))
    for (const p of posted) {
      const d = new Date(p.postedAt!)
      const day = (d.getDay() + 6) % 7
      const slot = Math.floor(d.getHours() / 3)
      grid[day][slot].count++
      grid[day][slot].eng += engagement(p)
    }
    return DAY_LABELS.map((label, day) => ({
      label,
      cells: grid[day].map(cell => ({ count: cell.count, avg: cell.count > 0 ? cell.eng / cell.count : 0 })),
    }))
  }, [posted])

  const tagStats = useMemo(() => {
    const map = new Map<string, { n: number; eng: number }>()
    for (const p of posted) {
      for (const tag of p.tags) {
        if (PROVENANCE_TAGS.has(tag)) continue
        const acc = map.get(tag) ?? { n: 0, eng: 0 }
        acc.n++
        acc.eng += engagement(p)
        map.set(tag, acc)
      }
    }
    let entries = [...map.entries()].map(([tag, s]) => ({ tag, n: s.n, eng: s.eng, avg: Math.round(s.eng / s.n) }))
    const solid = entries.filter(e => e.n >= 2)
    if (solid.length >= 3) entries = solid
    return entries.sort((a, b) => b.avg - a.avg).slice(0, 8)
  }, [posted])

  const topPosts = useMemo(() => [...posted].sort((a, b) => engagement(b) - engagement(a)).slice(0, 5), [posted])

  async function runAnalysis() {
    setAiBusy(true)
    setAiError('')
    try {
      setAnalysis(await analyzeTopPosts(topPosts.length >= 5 ? [...posted].sort((a, b) => engagement(b) - engagement(a)) : posted))
    } catch (e) {
      setAiError((e as Error).message)
    } finally {
      setAiBusy(false)
    }
  }

  return (
    <div className="insights">
      <div className="filter-row" role="group" aria-label="Filters">
        <span className="filter-label">Range</span>
        {RANGE_OPTIONS.map(o => (
          <button key={o.value} className={range === o.value ? 'seg on' : 'seg'} onClick={() => setRange(o.value)}>
            {o.label}
          </button>
        ))}
        <select value={platformFilter} onChange={e => setPlatformFilter(e.target.value as Platform | 'all')}>
          <option value="all">All platforms</option>
          {PLATFORMS.map(pl => (
            <option key={pl} value={pl}>
              {PLATFORM_META[pl].label}
            </option>
          ))}
        </select>
        <label className="filter-check">
          <input type="checkbox" checked={excludeReplies} onChange={e => setExcludeReplies(e.target.checked)} />
          Exclude replies
        </label>
      </div>

      {posted.length === 0 ? (
        <p className="empty">
          No posted posts in this range yet. Mark posts as posted, log past posts, or import an account archive from
          the Posts tab — then this page lights up.
        </p>
      ) : (
        <>
          <div className="kpi-row">
            <StatTile
              label="Posts published"
              value={String(cur.count)}
              delta={{ cur: cur.count, prev: prev?.count ?? null, periodLabel }}
            />
            <StatTile
              label="Total engagement"
              value={fmtNum(cur.eng)}
              sub="likes + comments + shares"
              delta={{ cur: cur.eng, prev: prev?.eng ?? null, periodLabel }}
            />
            <StatTile
              label="Engagement rate"
              value={cur.rate !== null ? `${cur.rate.toFixed(1)}%` : '—'}
              sub="engagement ÷ impressions"
              delta={
                cur.rate !== null && prev?.rate != null
                  ? { cur: cur.rate, prev: prev.rate, periodLabel }
                  : undefined
              }
            />
            <StatTile
              label="Avg engagement per post"
              value={fmtNum(cur.avg)}
              delta={{ cur: cur.avg, prev: prev ? prev.avg : null, periodLabel }}
            />
            <StatTile
              label="Impressions"
              value={fmtNum(cur.impr)}
              delta={{ cur: cur.impr, prev: prev?.impr ?? null, periodLabel }}
            />
          </div>

          <div className="charts-grid">
            <ChartCard
              title="Publishing cadence"
              subtitle={cadence.unit === 'week' ? 'Posts published per week' : 'Posts published per month'}
              columns={[cadence.unit === 'week' ? 'Week of' : 'Month', 'Posts']}
              rows={cadence.data.map(d => [d.label, d.value])}
            >
              <ColumnChart data={cadence.data} formatValue={n => String(n)} integerTicks />
            </ChartCard>

            <ChartCard
              title="Engagement by platform"
              subtitle="Likes + comments + shares"
              columns={['Platform', 'Posts', 'Likes', 'Comments', 'Shares', 'Engagement', 'Impressions']}
              rows={byPlatform.map(([pl, m]) => [
                PLATFORM_META[pl].label,
                m.posts,
                m.likes,
                m.comments,
                m.shares,
                m.likes + m.comments + m.shares,
                m.impressions,
              ])}
            >
              <HBarChart
                data={byPlatform.map(([pl, m]) => ({
                  label: PLATFORM_META[pl].label,
                  value: m.likes + m.comments + m.shares,
                }))}
              />
            </ChartCard>
          </div>

          <ChartCard
            title="Best time to post"
            subtitle="Average engagement per post by publish day and time"
            columns={['Day', ...SLOT_LABELS]}
            rows={heatRows.map(r => [r.label, ...r.cells.map(c => (c.count > 0 ? Math.round(c.avg) : '—'))])}
          >
            <Heatmap rows={heatRows} colLabels={SLOT_LABELS} />
          </ChartCard>

          <div className="charts-grid">
            <ChartCard
              title="What performs, by tag"
              subtitle="Average engagement per post"
              columns={['Tag', 'Posts', 'Avg engagement', 'Total']}
              rows={tagStats.map(t => [`#${t.tag}`, t.n, t.avg, t.eng])}
            >
              {tagStats.length === 0 ? (
                <p className="empty">Tag your posts to see which topics perform.</p>
              ) : (
                <HBarChart data={tagStats.map(t => ({ label: `#${t.tag} · ${t.n}`, value: t.avg }))} />
              )}
            </ChartCard>

            <section className="chart-card">
              <header className="chart-head">
                <div>
                  <h3>AI analysis</h3>
                  <p className="chart-sub">What your top posts have in common</p>
                </div>
                <button className="btn" disabled={aiBusy || posted.length < 3} onClick={runAnalysis}>
                  {aiBusy ? 'Analyzing…' : analysis ? 'Re-run' : 'Analyze'}
                </button>
              </header>
              {aiError && <p className="warn">{aiError}</p>}
              {analysis ? (
                <div className="ai-analysis">{analysis}</div>
              ) : (
                !aiError && (
                  <p className="empty">
                    {posted.length < 3
                      ? 'Needs at least 3 posted posts in range.'
                      : 'Sends your top posts (text + numbers) to Claude and reports the patterns.'}
                  </p>
                )
              )}
            </section>
          </div>

          <section className="chart-card">
            <header className="chart-head">
              <div>
                <h3>Top posts</h3>
                <p className="chart-sub">By engagement in this range</p>
              </div>
            </header>
            <ol className="top-posts">
              {topPosts.map(p => (
                <li key={p.id}>
                  <div className="top-main">
                    <div className="top-title">{p.title || p.body.slice(0, 60) || 'Untitled'}</div>
                    <div className="top-meta">
                      {p.platforms.map(pl => (
                        <span key={pl} className="chip platform" style={{ background: PLATFORM_META[pl].color }}>
                          {PLATFORM_META[pl].short}
                        </span>
                      ))}
                      <span>{fmtDate(p.postedAt)}</span>
                    </div>
                  </div>
                  <div className="top-nums">
                    <span>
                      <strong>{fmtNum(engagement(p))}</strong> <small>engagement</small>
                    </span>
                    <span>
                      {fmtNum(impressions(p))} <small>impressions</small>
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </div>
  )
}
