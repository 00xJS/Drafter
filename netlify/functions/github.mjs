// GitHub link cards: the app pastes an issue / PR / repo / Projects URL onto a
// task and this proxy returns its live state. Read-only. Uses GITHUB_TOKEN
// when set (needed for private repos and for Projects v2, which is GraphQL-only);
// public issues and repos work unauthenticated at GitHub's low anonymous rate.
//
// Session-gated exactly like /api/ai so the public site can't relay requests.

const API = 'https://api.github.com'

function parseRef(input) {
  let u
  try {
    u = new URL(input)
  } catch {
    return null
  }
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null
  const parts = u.pathname.split('/').filter(Boolean)
  if (parts.length >= 4 && (parts[0] === 'orgs' || parts[0] === 'users') && parts[2] === 'projects') {
    return { type: 'project', owner: parts[1], ownerType: parts[0] === 'orgs' ? 'organization' : 'user', number: Number(parts[3]) }
  }
  if (parts.length >= 4 && parts[2] === 'issues' && /^\d+$/.test(parts[3])) {
    return { type: 'issue', owner: parts[0], repo: parts[1], number: Number(parts[3]) }
  }
  if (parts.length >= 4 && parts[2] === 'pull' && /^\d+$/.test(parts[3])) {
    return { type: 'pr', owner: parts[0], repo: parts[1], number: Number(parts[3]) }
  }
  if (parts.length >= 2) return { type: 'repo', owner: parts[0], repo: parts[1] }
  return null
}

async function gh(path, token, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'drafter-planner',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const err = new Error(`GitHub ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

const labels = list => (list ?? []).map(l => ({ name: l.name, color: l.color ? `#${l.color}` : undefined }))
const logins = list => (list ?? []).map(a => a.login)

async function resolve(ref, token) {
  if (ref.type === 'issue') {
    const i = await gh(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`, token)
    const isPr = !!i.pull_request
    return {
      type: isPr ? 'pr' : 'issue',
      repo: `${ref.owner}/${ref.repo}`,
      number: i.number,
      title: i.title,
      state: i.state === 'closed' ? (isPr && i.pull_request?.merged_at ? 'merged' : 'closed') : 'open',
      url: i.html_url,
      labels: labels(i.labels),
      assignees: logins(i.assignees),
      comments: i.comments,
      updatedAt: i.updated_at,
      milestone: i.milestone?.title,
    }
  }
  if (ref.type === 'pr') {
    const p = await gh(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, token)
    return {
      type: 'pr',
      repo: `${ref.owner}/${ref.repo}`,
      number: p.number,
      title: p.title,
      state: p.merged_at ? 'merged' : p.draft ? 'draft' : p.state === 'closed' ? 'closed' : 'open',
      url: p.html_url,
      labels: labels(p.labels),
      assignees: logins(p.assignees),
      comments: (p.comments ?? 0) + (p.review_comments ?? 0),
      updatedAt: p.updated_at,
      milestone: p.milestone?.title,
    }
  }
  if (ref.type === 'repo') {
    const r = await gh(`/repos/${ref.owner}/${ref.repo}`, token)
    return {
      type: 'repo',
      repo: r.full_name,
      title: r.description || r.full_name,
      state: r.archived ? 'closed' : 'open',
      url: r.html_url,
      labels: [],
      assignees: [],
      openIssues: r.open_issues_count,
      stars: r.stargazers_count,
      updatedAt: r.pushed_at ?? r.updated_at,
    }
  }
  if (ref.type === 'project') {
    if (!token) throw Object.assign(new Error('GitHub Projects need GITHUB_TOKEN (scope: read:project) on the host.'), { status: 501 })
    const field = ref.ownerType === 'organization' ? 'organization' : 'user'
    const query = `query($login: String!, $number: Int!) { ${field}(login: $login) { projectV2(number: $number) { title shortDescription closed url updatedAt items { totalCount } } } }`
    const data = await gh('/graphql', token, { method: 'POST', body: JSON.stringify({ query, variables: { login: ref.owner, number: ref.number } }) })
    const p = data?.data?.[field]?.projectV2
    if (!p) throw Object.assign(new Error(data?.errors?.[0]?.message ?? 'Project not found'), { status: 404 })
    return {
      type: 'project',
      repo: ref.owner,
      number: ref.number,
      title: p.title,
      state: p.closed ? 'closed' : 'open',
      url: p.url,
      labels: [],
      assignees: [],
      description: p.shortDescription ?? undefined,
      items: p.items?.totalCount,
      updatedAt: p.updatedAt,
    }
  }
  throw Object.assign(new Error('unsupported GitHub URL'), { status: 400 })
}

export default async req => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
  if (supabaseUrl && anonKey) {
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!token) return Response.json({ error: 'sign in required' }, { status: 401 })
    const check = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, authorization: `Bearer ${token}` },
    })
    if (!check.ok) return Response.json({ error: 'invalid session' }, { status: 401 })
  }

  const url = new URL(req.url).searchParams.get('url') ?? ''
  const ref = parseRef(url)
  if (!ref) return Response.json({ error: 'not a GitHub issue, pull request, repository or project URL' }, { status: 400 })

  try {
    const card = await resolve(ref, process.env.GITHUB_TOKEN)
    return Response.json(card, { headers: { 'cache-control': 'private, max-age=120' } })
  } catch (e) {
    const status = e?.status === 404 ? 404 : e?.status === 501 ? 501 : e?.status === 403 || e?.status === 429 ? 429 : 502
    const message =
      status === 404
        ? 'Not found on GitHub (private? set GITHUB_TOKEN on the host).'
        : status === 429
          ? 'GitHub rate limit hit — set GITHUB_TOKEN on the host for a much higher limit.'
          : (e?.message ?? 'GitHub request failed')
    return Response.json({ error: message }, { status })
  }
}
