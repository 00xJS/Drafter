// Drafter's rows over PostgREST, for the MCP tools. Zero dependencies.
//
// Two modes:
//   user     the hosted endpoint: every request carries the user's own JWT,
//            so the posts policies decide what is visible and new rows belong
//            to that user. Journal reads are filtered to the user's own rows.
//   service  the deprecated local stdio mode: the service key sees every row
//            of every account, so this module applies the owner's view itself
//            (ownerMaySee) and writes land as the site owner.
//
// Reads page through PostgREST with Range headers. supabase/config.toml caps a
// response at max_rows = 1000, and the old server read one page and silently
// stopped there.

import { legacyPostToTask } from '../shared/domain.mjs'
import { PERSONAL_KINDS, kindOf, readableKind } from '../shared/kinds.mjs'

export { PERSONAL_KINDS }

/** Rows per request; must not exceed the project's max_rows. */
export const PAGE_SIZE = 1000
/** sync_posts echoes rows synced since this long before the write, not the whole table. */
export const SINCE_WINDOW_MS = 10 * 60_000

const POSTS = '/rest/v1/posts?select=data,user_id&deleted=is.false&order=updated_at.desc,id.asc'

/**
 * The posts policy as `owner` meets it, for reads that bypass it (the service
 * key): the owner's own rows and legacy unowned ones (user_id null) pass,
 * anyone else's only when the kind is shared with the household.
 */
export function ownerMaySee(row, owner) {
  return row?.user_id === null || readableKind(kindOf(row?.data), row?.user_id, owner)
}

export class DataError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

const withOwner = row => ({ ...legacyPostToTask(row.data), ownerId: row.user_id ?? undefined })

/**
 * createRestData({ baseUrl, auth, userId, mode, onUnauthorized })
 *   auth()           -> Promise<{ apikey, bearer }>, called per request (lazily: nothing is minted until a tool reads)
 *   onUnauthorized() -> called once on a 401 before the request is retried (the hosted endpoint drops the session)
 */
export function createRestData({ baseUrl, auth, userId = null, mode = 'user', onUnauthorized = null }) {
  if (mode !== 'user' && mode !== 'service') throw new Error(`unknown data mode "${mode}"`)
  if (mode === 'user' && !userId) throw new Error('user mode needs the user id')
  const base = String(baseUrl ?? '').replace(/\/+$/, '')

  async function request(path, init = {}, retried = false) {
    if (!base) throw new Error('Server is not configured: no Supabase URL.')
    const { apikey, bearer } = await auth()
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { apikey, authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
    if (res.status === 401 && !retried && onUnauthorized) {
      // an expired or signed-out session is refused before anything runs, so one retry is safe
      await res.text().catch(() => '')
      onUnauthorized()
      return request(path, init, true)
    }
    return res
  }

  async function api(path, init) {
    const res = await request(path, init)
    const text = await res.text()
    if (!res.ok) throw new DataError(`Supabase ${res.status}: ${text.slice(0, 300)}`, res.status)
    return text ? JSON.parse(text) : null
  }

  /** Every row of a GET, a page at a time until a short page. */
  async function getAll(path) {
    const rows = []
    for (let from = 0; ; from += PAGE_SIZE) {
      const res = await request(path, { headers: { 'range-unit': 'items', range: `${from}-${from + PAGE_SIZE - 1}` } })
      const text = await res.text()
      if (res.status === 416) break // asked for a page past the end
      if (!res.ok) throw new DataError(`Supabase ${res.status}: ${text.slice(0, 300)}`, res.status)
      const page = text ? JSON.parse(text) : []
      if (!Array.isArray(page)) throw new DataError('Supabase answered a read with something other than a list of rows.', 502)
      rows.push(...page)
      if (page.length < PAGE_SIZE) break
    }
    // a row edited between two pages moves to the front and can be read twice
    const seen = new Set()
    return rows.filter(r => {
      const id = r?.data?.id
      if (id === undefined) return true
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  }

  let ownerCache
  /** Whose view the rows are read in: the user, or (service key) the site owner sync_posts writes as. */
  async function ownerId() {
    if (mode === 'user') return userId
    if (ownerCache === undefined) ownerCache = (await api('/rest/v1/rpc/owner_user_id', { method: 'POST', body: '{}' })) ?? null
    return ownerCache
  }

  /** All live rows this view may see, normalized to v3 shape, each with its ownerId. */
  async function fetchAll({ kinds } = {}) {
    let path = POSTS
    if (Array.isArray(kinds) && kinds.length) {
      for (const k of kinds) if (!/^[a-z]+$/.test(k)) throw new Error(`bad kind "${k}"`)
      // the generated kind column reads a legacy row (no kind) as a task
      path += `&kind=in.(${kinds.join(',')})`
    }
    const [rows, owner] = await Promise.all([getAll(path), ownerId()])
    return rows.filter(r => ownerMaySee(r, owner)).map(withOwner)
  }

  /** One row by id, checked for kind. Another member's personal row reads as missing: even its kind would say too much. */
  async function fetchItem(id, kind) {
    const [rows, owner] = await Promise.all([api(`/rest/v1/posts?id=eq.${encodeURIComponent(id)}&select=data,user_id`), ownerId()])
    const row = rows?.[0]
    const item = row?.data && ownerMaySee(row, owner) ? withOwner(row) : null
    if (!item) throw new Error(`No ${kind} with id "${id}".`)
    if (item.deletedAt) throw new Error(`${kind} "${id}" is deleted.`)
    if (item.kind !== kind) throw new Error(`"${id}" is a ${item.kind}, not a ${kind}.`)
    return item
  }

  /** The viewer's own journal — never a household peer's diary. */
  async function fetchJournal() {
    if (mode === 'user') return (await getAll(`${POSTS}&kind=eq.journal&user_id=eq.${encodeURIComponent(userId)}`)).map(withOwner)
    const [rows, owner] = await Promise.all([getAll(`${POSTS}&kind=eq.journal`), ownerId()])
    return rows.filter(r => ownerMaySee(r, owner)).map(withOwner)
  }

  /**
   * Write items through the last-write-wins merge and return the stored copies
   * of exactly those items. sync_posts has answered { items, rejected, stale,
   * gone } since v3.11 ({ items, rejected } before, a bare array before that);
   * a future `since` would echo nothing, and none would echo the whole table,
   * so it gets the last ten minutes and anything not in the echo is read back.
   */
  async function syncWrite(items) {
    const since = new Date(Date.now() - SINCE_WINDOW_MS).toISOString()
    const res = await api('/rest/v1/rpc/sync_posts', { method: 'POST', body: JSON.stringify({ incoming: items, since }) })
    const list = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : []
    const listed = key => (Array.isArray(res?.[key]) ? res[key] : [])
    const ids = items.map(i => i.id)
    const refused = ids.filter(id => listed('rejected').includes(id))
    if (refused.length) throw new Error(`The server refused to store ${refused.join(', ')} (unknown kind or invalid record — is the newest migration applied?).`)
    const gone = ids.filter(id => listed('gone').includes(id))
    if (gone.length) throw new Error(`That record was deleted for good (${gone.join(', ')}).`)
    const stale = ids.filter(id => listed('stale').includes(id))
    if (stale.length) throw new Error(`A newer edit to that record won — re-read it and try again (${stale.join(', ')}).`)

    const sent = new Set(ids)
    const stored = new Map()
    for (const p of list) if (p && sent.has(p.id)) stored.set(p.id, p)
    // an exact re-push of what is stored changes nothing, so it is outside the window: confirm it by reading
    for (const id of ids) {
      if (stored.has(id)) continue
      const rows = await api(`/rest/v1/posts?id=eq.${encodeURIComponent(id)}&select=data`)
      if (rows?.[0]?.data) stored.set(id, rows[0].data)
    }
    const lost = ids.filter(id => !stored.has(id))
    if (lost.length) throw new Error(`The server did not keep ${lost.join(', ')} — re-read it and try again.`)
    return ids.map(id => legacyPostToTask(stored.get(id)))
  }

  /** Persist one edited item and confirm the write won the merge. */
  async function writeItem(item) {
    const stored = (await syncWrite([item])).find(p => p.id === item.id)
    if (!stored || stored.updatedAt !== item.updatedAt) {
      throw new Error('Write was rejected by the last-write-wins merge (a newer copy exists). Re-read the item and retry.')
    }
    return stored
  }

  return { mode, userId, ownerId, fetchAll, fetchItem, fetchJournal, syncWrite, writeItem }
}
