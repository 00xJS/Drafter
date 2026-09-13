import { withCors } from './lib/cors.mjs'
import { requireUser } from './lib/session.mjs'
// GitHub link cards: the app pastes an issue / PR / repo / Projects URL onto a
// task and this proxy returns its live state. Read-only. Uses GITHUB_TOKEN
// when set (needed for private repos and for Projects v2, which is GraphQL-only);
// public issues and repos work unauthenticated at GitHub's low anonymous rate.
//
// Session-gated exactly like /api/ai so the public site can't relay requests,
// and failing closed the same way (requireUser): GITHUB_TOKEN can write, so a
// host missing its auth settings answers 503 instead of relaying for anyone.

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
    throw Object.assign(new Error(`GitHub ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`), { status: res.status })
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

// ---- Projects v2 (two-way sync) ---------------------------------------------
// Everything below is GraphQL: the REST API has no Projects v2 surface. A token
// without the `project` scope answers 403 / FORBIDDEN, which we translate into
// the same 501 "the host cannot do this" the read-only project card returns, so
// the client can say so plainly instead of showing a generic failure. A 403 is
// also how GitHub reports a secondary rate limit, so that is checked first — the
// scope hint is only right when the response actually says it is about a scope.

const PROJECT_SCOPE_HINT = 'GitHub Projects write-back needs GITHUB_TOKEN with the `project` scope (read and write) on the host.'
// A token IS present by the time any of this runs (write() refuses without
// one), so the read path's "set GITHUB_TOKEN" advice does not apply here.
const RATE_LIMIT_HINT = 'GitHub rate limit hit — wait a minute and try again.'

function scopeError(message) {
  return /scope|forbidden|not accessible|permission|insufficient/i.test(String(message ?? ''))
}

/**
 * GitHub answers 403 for a secondary / abuse rate limit as well as for a
 * missing scope, and the read path already tells the two apart. Checking the
 * limit FIRST keeps this path from telling the owner to add a `project` scope
 * their token already has — the only place either message is seen is the
 * project editor, which prints it verbatim.
 */
function rateLimited(status, message) {
  return status === 429 || (status === 403 && /rate limit|abuse|secondary/i.test(String(message ?? '')))
}

async function graphql(query, variables, token) {
  let data
  try {
    data = await gh('/graphql', token, { method: 'POST', body: JSON.stringify({ query, variables }) })
  } catch (e) {
    if (rateLimited(e?.status, e?.message)) throw Object.assign(new Error(RATE_LIMIT_HINT), { status: 429 })
    if (e?.status === 401 || e?.status === 403 || scopeError(e?.message)) throw Object.assign(new Error(PROJECT_SCOPE_HINT), { status: 501 })
    throw e
  }
  const first = data?.errors?.[0]
  if (first) {
    const message = first.message ?? 'GitHub GraphQL error'
    // GraphQL reports its own throttling in the payload, with a 200 above it
    if (first.type === 'RATE_LIMITED' || rateLimited(403, message)) throw Object.assign(new Error(RATE_LIMIT_HINT), { status: 429 })
    if (first.type === 'FORBIDDEN' || scopeError(message)) throw Object.assign(new Error(`${PROJECT_SCOPE_HINT} (GitHub said: ${message})`), { status: 501 })
    throw Object.assign(new Error(message), { status: first.type === 'NOT_FOUND' ? 404 : 502 })
  }
  return data?.data
}

/** The value bits of a project item we care about: its Status option and its Date fields. */
const ITEM_FIELDS = `
  id
  updatedAt
  content { __typename ... on Issue { url } ... on PullRequest { url } }
  fieldValues(first: 30) {
    nodes {
      __typename
      ... on ProjectV2ItemFieldSingleSelectValue { optionId name field { ... on ProjectV2FieldCommon { id name } } }
      ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { id name } } }
    }
  }`

/** Shape one item node for the client, picking the requested Status / Date fields. */
function itemOf(node, statusFieldId, dateFieldId) {
  if (!node) return null
  const values = node.fieldValues?.nodes ?? []
  const named = v => String(v?.field?.name ?? '').toLowerCase()
  const status = values.find(v => v?.optionId && (statusFieldId ? v.field?.id === statusFieldId : named(v) === 'status'))
  const date = values.find(v => v?.date && (dateFieldId ? v.field?.id === dateFieldId : true))
  return {
    itemId: node.id,
    updatedAt: node.updatedAt,
    contentUrl: node.content?.url ?? undefined,
    statusFieldId: status?.field?.id ?? undefined,
    statusOptionId: status?.optionId ?? undefined,
    statusName: status?.name ?? undefined,
    dateFieldId: date?.field?.id ?? undefined,
    date: date?.date ?? undefined,
  }
}

async function projectFields(ref, token) {
  const owner = ref.ownerType === 'organization' ? 'organization' : 'user'
  const query = `query($login: String!, $number: Int!) {
    ${owner}(login: $login) {
      projectV2(number: $number) {
        id
        title
        fields(first: 50) {
          nodes {
            __typename
            ... on ProjectV2FieldCommon { id name dataType }
            ... on ProjectV2SingleSelectField { id name dataType options { id name } }
          }
        }
      }
    }
  }`
  const data = await graphql(query, { login: ref.owner, number: ref.number }, token)
  const p = data?.[owner]?.projectV2
  if (!p) throw Object.assign(new Error('Project not found'), { status: 404 })
  const nodes = (p.fields?.nodes ?? []).filter(Boolean)
  const selects = nodes.filter(n => n.dataType === 'SINGLE_SELECT' && Array.isArray(n.options))
  const status = selects.find(n => String(n.name).toLowerCase() === 'status') ?? selects[0]
  return {
    projectId: p.id,
    title: p.title,
    statusField: status ? { id: status.id, name: status.name, options: status.options.map(o => ({ id: o.id, name: o.name })) } : undefined,
    selectFields: selects.map(n => ({ id: n.id, name: n.name, options: n.options.map(o => ({ id: o.id, name: o.name })) })),
    dateFields: nodes.filter(n => n.dataType === 'DATE').map(n => ({ id: n.id, name: n.name })),
  }
}

/** One item: the board row for a given issue / PR. Asked content-side so we never page the board. */
async function projectItem(ref, contentRef, body, token) {
  const query = `query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issueOrPullRequest(number: $number) {
        __typename
        ... on Issue { projectItems(first: 20) { nodes { project { id url } ${ITEM_FIELDS} } } }
        ... on PullRequest { projectItems(first: 20) { nodes { project { id url } ${ITEM_FIELDS} } } }
      }
    }
  }`
  const data = await graphql(query, { owner: contentRef.owner, repo: contentRef.repo, number: contentRef.number }, token)
  const nodes = data?.repository?.issueOrPullRequest?.projectItems?.nodes ?? []
  const tail = `/${ref.ownerType === 'organization' ? 'orgs' : 'users'}/${ref.owner}/projects/${ref.number}`
  const hit = nodes.find(n => String(n?.project?.url ?? '').replace(/\/+$/, '').toLowerCase().endsWith(tail.toLowerCase()))
  return { projectId: hit?.project?.id ?? undefined, item: hit ? itemOf(hit, body.statusFieldId, body.dateFieldId) : null }
}

/** Every item on the board (up to 300), for the periodic pull. */
async function projectItems(ref, body, token) {
  const owner = ref.ownerType === 'organization' ? 'organization' : 'user'
  const query = `query($login: String!, $number: Int!, $after: String) {
    ${owner}(login: $login) {
      projectV2(number: $number) {
        id
        items(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { ${ITEM_FIELDS} }
        }
      }
    }
  }`
  const items = []
  let after = null
  let projectId
  // Bounded because each page is 100 nodes of 30 field values and the function
  // has a request budget. Hitting the bound is REPORTED rather than swallowed:
  // a row past the last page reconciles against nothing, so those tasks would
  // simply never pull, and "the board moved nothing" and "the app never saw the
  // row" look identical from the app.
  let truncated = false
  for (let page = 0; page < 3; page++) {
    const data = await graphql(query, { login: ref.owner, number: ref.number, after }, token)
    const p = data?.[owner]?.projectV2
    if (!p) throw Object.assign(new Error('Project not found'), { status: 404 })
    projectId = p.id
    for (const node of p.items?.nodes ?? []) {
      const shaped = itemOf(node, body.statusFieldId, body.dateFieldId)
      if (shaped?.contentUrl) items.push(shaped)
    }
    truncated = !!p.items?.pageInfo?.hasNextPage
    if (!truncated) break
    after = p.items.pageInfo.endCursor
  }
  return { projectId, items, truncated }
}

const SET_FIELD = `mutation($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: $value }) { projectV2Item { id } }
}`
const CLEAR_FIELD = `mutation($project: ID!, $item: ID!, $field: ID!) {
  clearProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field }) { projectV2Item { id } }
}`

async function projectSet(body, token) {
  const projectId = String(body.projectId ?? '')
  const itemId = String(body.itemId ?? '')
  if (!projectId || !itemId) return Response.json({ error: 'projectId and itemId are required' }, { status: 400 })
  let wrote = 0
  if (body.statusFieldId && body.optionId) {
    await graphql(SET_FIELD, { project: projectId, item: itemId, field: String(body.statusFieldId), value: { singleSelectOptionId: String(body.optionId) } }, token)
    wrote++
  }
  if (body.dateFieldId && body.date !== undefined) {
    const date = body.date === null ? null : String(body.date)
    if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: 'date must be YYYY-MM-DD or null' }, { status: 400 })
    if (date === null) await graphql(CLEAR_FIELD, { project: projectId, item: itemId, field: String(body.dateFieldId) }, token)
    else await graphql(SET_FIELD, { project: projectId, item: itemId, field: String(body.dateFieldId), value: { date } }, token)
    wrote++
  }
  return Response.json({ ok: true, wrote })
}

async function write(req) {
  const token = process.env.GITHUB_TOKEN
  const body = await req.json().catch(() => ({}))
  if (!token)
    return Response.json(
      { error: String(body.action ?? '').startsWith('project-') ? PROJECT_SCOPE_HINT : 'GitHub write-back needs GITHUB_TOKEN (with repo/issues write access) on the host.' },
      { status: 501 },
    )
  try {
    if (body.action === 'close' || body.action === 'reopen') {
      const ref = parseRef(body.url ?? '')
      if (!ref || (ref.type !== 'issue' && ref.type !== 'pr')) return Response.json({ error: 'not an issue or pull request URL' }, { status: 400 })
      const i = await gh(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`, token, {
        method: 'PATCH',
        body: JSON.stringify(body.action === 'close' ? { state: 'closed', state_reason: 'completed' } : { state: 'open' }),
      })
      return Response.json({ ok: true, state: i.state, url: i.html_url })
    }
    if (body.action === 'create') {
      const ref = parseRef(body.repoUrl ?? '')
      if (!ref || !ref.repo) return Response.json({ error: 'give a repository URL' }, { status: 400 })
      const i = await gh(`/repos/${ref.owner}/${ref.repo}/issues`, token, {
        method: 'POST',
        body: JSON.stringify({ title: String(body.title ?? 'Task').slice(0, 200), body: String(body.body ?? '').slice(0, 20000) }),
      })
      return Response.json({ ok: true, url: i.html_url, number: i.number })
    }
    if (body.action === 'project-fields' || body.action === 'project-items' || body.action === 'project-item') {
      const ref = parseRef(body.url ?? '')
      if (!ref || ref.type !== 'project' || !Number.isFinite(ref.number)) return Response.json({ error: 'give a GitHub Projects board URL' }, { status: 400 })
      if (body.action === 'project-fields') return Response.json(await projectFields(ref, token))
      if (body.action === 'project-items') return Response.json(await projectItems(ref, body, token))
      const contentRef = parseRef(body.contentUrl ?? '')
      if (!contentRef || (contentRef.type !== 'issue' && contentRef.type !== 'pr')) return Response.json({ error: 'contentUrl must be an issue or pull request URL' }, { status: 400 })
      return Response.json(await projectItem(ref, contentRef, body, token))
    }
    if (body.action === 'project-set') return await projectSet(body, token)
    return Response.json({ error: 'unknown action' }, { status: 400 })
  } catch (e) {
    // 429 passes through: a throttled write is a "come back in a minute", not
    // a broken gateway, and graphql() already worded it as one
    const status = e?.status === 404 ? 404 : e?.status === 501 ? 501 : e?.status === 429 ? 429 : 502
    return Response.json({ error: e?.message ?? 'GitHub write failed' }, { status })
  }
}

const handler = async req => {
  if (req.method !== 'GET' && req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const { response } = await requireUser(req)
  if (response) return response

  if (req.method === 'POST') return write(req)
  const url = new URL(req.url).searchParams.get('url') ?? ''
  const ref = parseRef(url)
  if (!ref) return Response.json({ error: 'not a GitHub issue, pull request, repository or project URL' }, { status: 400 })

  try {
    const card = await resolve(ref, process.env.GITHUB_TOKEN)
    return Response.json({ ...card, canWrite: !!process.env.GITHUB_TOKEN }, { headers: { 'cache-control': 'private, max-age=120' } })
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

export default withCors(handler)
