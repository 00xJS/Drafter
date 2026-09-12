// Three-way merge of one synced record, for when two devices edited the same
// row between syncs. The server keeps last-write-wins per row, so without this
// the loser's whole edit vanished — even when the two edits touched different
// fields (a title here, a ticked checklist line there). Shared like every rule
// in this folder, so a future writer with its own sync loop (the MCP server)
// cannot disagree with the app about it. Dependency-free ESM.
//
// The rule, per top-level field: take the local value when only this device
// changed it since the base (the last version the server confirmed), otherwise
// the remote one. Lists of records with a stable key (checklist lines,
// comments, grocery lines, routine steps, milestones) merge per element by the
// same rule, keeping additions from both sides and honouring a deletion on one
// side when the other side left that element alone. String sets (a habit's
// done days, a routine's ticks, tags, id lists) keep members added on either
// side. With no base — a deterministic id such as meal~<date>~<slot> created
// on two devices — lists are unioned and the remote side wins every scalar
// disagreement.

import { ingredientKey } from './kitchen.mjs'

/** Bookkeeping, not content: never merged field by field and never a conflict. */
const META = new Set(['id', 'kind', 'createdAt', 'updatedAt', 'ownerId', 'syncedAt'])
/** Inside a list element the key is the identity; the id rides along with the remote side. */
const ELEMENT_SKIP = new Set(['id'])
/** Stamps and server annotations: two copies that differ only here hold the same content. */
const BOOKKEEPING = ['updatedAt', 'syncedAt', 'ownerId']

/**
 * String lists that are sets rather than sequences. Every other list of plain
 * values (a recipe's steps, a review's top three) is ordered and moves as one.
 */
export const SET_FIELDS = new Set(['done', 'ticks', 'tags', 'peopleIds', 'mediaIds', 'blockedBy', 'recipeIds'])

/** The sanitizers turn an empty optional field into `undefined`, editors often leave '' or []: all one "nothing". */
function isEmpty(v) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
}

/** Deep equality where every flavour of "nothing" is equal and key order never matters. */
export function same(a, b) {
  if (a === b) return true
  if (isEmpty(a) || isEmpty(b)) return isEmpty(a) && isEmpty(b)
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false
    return true
  }
  if (typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!same(a[k], b[k])) return false
    return true
  }
  return false
}

function strip(record, keys) {
  const out = { ...record }
  for (const k of keys) delete out[k]
  return out
}

/** Two copies of a record hold the same content: only stamps and server annotations differ. */
export function sameContent(a, b) {
  if (!a || !b) return !a && !b
  return same(strip(a, BOOKKEEPING), strip(b, BOOKKEEPING))
}

/**
 * What makes two list elements "the same line". Grocery lines go by name and
 * unit, the key buildGroceryList itself matches on: a line can arrive with a
 * sanitizer's positional id (g-1, g-2…) or with a different random id for the
 * same hand-added item on each device, and neither is an identity. Everything
 * else goes by its id. Null when the element has no usable key.
 */
export function elementKey(kind, field, el) {
  if (!el || typeof el !== 'object' || Array.isArray(el)) return null
  if (kind === 'grocery' && field === 'items') {
    return typeof el.name === 'string' && el.name.trim() ? ingredientKey(el.name, el.unit) : null
  }
  return typeof el.id === 'string' && el.id ? el.id : null
}

/** Every version present is a list whose elements all carry a key. */
function isKeyedList(kind, field, versions) {
  let any = false
  for (const v of versions) {
    if (v === undefined || v === null) continue
    if (!Array.isArray(v)) return false
    any = true
    for (const el of v) if (elementKey(kind, field, el) === null) return false
  }
  return any
}

function isStringList(v) {
  return v === undefined || v === null || (Array.isArray(v) && v.every(x => typeof x === 'string'))
}

function isSorted(list) {
  return !list || list.every((x, i) => i === 0 || list[i - 1] <= x)
}

/** Elements by key, in order. A key repeated within one list gets #2, #3… so neither copy is lost. */
function indexList(kind, field, list) {
  const map = new Map()
  const keys = []
  const seen = new Map()
  for (const el of list ?? []) {
    const k0 = elementKey(kind, field, el)
    const n = (seen.get(k0) ?? 0) + 1
    seen.set(k0, n)
    const k = n === 1 ? k0 : `${k0}#${n}`
    map.set(k, el)
    keys.push(k)
  }
  return { map, keys }
}

/** The empty value a merged list should take: [] when either side kept a list, else nothing. */
function emptyList(l, r) {
  return Array.isArray(r) || Array.isArray(l) ? [] : undefined
}

/** A member stays if both sides have it, or one side added it; a member one side removed stays removed. */
function mergeSet(b, l, r, hasBase) {
  const B = new Set(hasBase ? (b ?? []) : [])
  const L = new Set(l ?? [])
  const R = new Set(r ?? [])
  const keep = x => (L.has(x) && R.has(x)) || (L.has(x) && !B.has(x)) || (R.has(x) && !B.has(x))
  const out = []
  const placed = new Set()
  for (const x of [...(r ?? []), ...(l ?? [])]) {
    if (placed.has(x) || !keep(x)) continue
    placed.add(x)
    out.push(x)
  }
  // day keys and ticks are stored sorted; keep them that way
  if (isSorted(l) && isSorted(r)) out.sort()
  return out.length ? out : emptyList(l, r)
}

function sameRelativeOrder(a, b) {
  const inA = new Set(a)
  const inB = new Set(b)
  const x = a.filter(k => inB.has(k))
  const y = b.filter(k => inA.has(k))
  return x.length === y.length && x.every((k, i) => k === y[i])
}

/**
 * The side that reordered the list sets the order (otherwise the server's
 * does); each element only the other side has goes in after its nearest
 * predecessor there, so a line added at the end stays at the end.
 */
function listOrder(bKeys, lKeys, rKeys, hasBase) {
  const moved = keys => hasBase && !sameRelativeOrder(bKeys, keys)
  const [primary, secondary] = moved(lKeys) && !moved(rKeys) ? [lKeys, rKeys] : [rKeys, lKeys]
  const out = [...primary]
  const placed = new Set(out)
  for (let i = 0; i < secondary.length; i++) {
    const k = secondary[i]
    if (placed.has(k)) continue
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const idx = out.indexOf(secondary[j])
      if (idx !== -1) {
        at = idx + 1
        break
      }
    }
    out.splice(at, 0, k)
    placed.add(k)
  }
  return out
}

function mergeList(ctx, field, b, l, r, hasBase, path) {
  const B = indexList(ctx.kind, field, hasBase ? b : undefined)
  const L = indexList(ctx.kind, field, l)
  const R = indexList(ctx.kind, field, r)
  const unchanged = (x, base) => same(strip(x, ELEMENT_SKIP), strip(base, ELEMENT_SKIP))
  const result = new Map()
  for (const k of new Set([...B.keys, ...L.keys, ...R.keys])) {
    const be = B.map.get(k)
    const le = L.map.get(k)
    const re = R.map.get(k)
    let v
    if (be !== undefined) {
      if (le === undefined && re === undefined) v = undefined
      // deleted on one side: honoured unless the other side changed that element
      else if (le === undefined) v = unchanged(re, be) ? undefined : re
      else if (re === undefined) v = unchanged(le, be) ? undefined : le
      else v = mergeFields(ctx, be, le, re, true, [...path, k], ELEMENT_SKIP)
    } else if (le !== undefined && re !== undefined) {
      // added on both sides under the same key
      v = mergeFields(ctx, undefined, le, re, false, [...path, k], ELEMENT_SKIP)
    } else {
      v = le ?? re
    }
    if (v !== undefined) result.set(k, v)
  }
  const out = listOrder(B.keys, L.keys, R.keys, hasBase)
    .filter(k => result.has(k))
    .map(k => result.get(k))
  return out.length ? out : emptyList(l, r)
}

function mergeValue(ctx, key, b, l, r, hasBase, path) {
  // keyed lists are a record's own fields; an element's fields are values or sets
  if (path.length === 1 && isKeyedList(ctx.kind, key, [b, l, r])) return mergeList(ctx, key, b, l, r, hasBase, path)
  if (SET_FIELDS.has(key) && isStringList(b) && isStringList(l) && isStringList(r)) return mergeSet(b, l, r, hasBase)
  // one value: nested objects (a bill, a recurrence) and ordered lists move whole
  if (hasBase) {
    if (same(l, b)) return r // only the other side (if either) changed it
    if (same(r, b)) return l // only this device changed it
    if (!same(l, r)) ctx.conflicts.push({ path, local: l, remote: r })
    return r
  }
  // no base: anything this device set that the other side set differently loses, visibly
  if (!isEmpty(l) && !same(l, r)) ctx.conflicts.push({ path, local: l, remote: r })
  return r
}

function mergeFields(ctx, b, l, r, hasBase, path, skip) {
  const out = { ...r }
  for (const key of new Set([...Object.keys(b ?? {}), ...Object.keys(l ?? {}), ...Object.keys(r ?? {})])) {
    if (skip.has(key)) continue
    const v = mergeValue(ctx, key, b?.[key], l?.[key], r?.[key], hasBase, [...path, key])
    if (v === undefined) delete out[key]
    else out[key] = v
  }
  return out
}

/**
 * Merge a pending local version with the server's, given the base both came
 * from (the last version this device knew the server had), or none.
 *
 * Returns the merged record — bookkeeping (kind, createdAt, updatedAt, ownerId)
 * is the server's; the caller stamps it newer before storing it — and every
 * place this device's edit lost to a different edit of the same field on the
 * other side, as `{ path, local, remote }`. A path is `[field]`, or
 * `[field, elementKey, subfield]` inside a keyed list.
 */
export function mergeRecord(base, local, remote) {
  if (!remote) return { merged: local, conflicts: [] }
  if (!local || local.kind !== remote.kind) return { merged: remote, conflicts: [] }
  // "Delete forever" is final: it beats any edit, and no edit brings it back
  if (remote.purged) return { merged: remote, conflicts: [] }
  if (local.purged) return { merged: { ...local, ownerId: remote.ownerId ?? local.ownerId }, conflicts: [] }
  const ctx = { kind: remote.kind, conflicts: [] }
  const merged = mergeFields(ctx, base ?? undefined, local, remote, !!base, [], META)
  if (merged.ownerId === undefined && local.ownerId !== undefined) merged.ownerId = local.ownerId
  return { merged, conflicts: ctx.conflicts }
}

/**
 * Put this device's side of each conflict back onto a record — the "Keep
 * mine" of a conflict toast. Returns a new record; the caller stamps it. A
 * path into a list element that is no longer there is skipped: the line it
 * named was deleted since, and a deletion is not re-argued here.
 */
export function applyLocalChoice(record, conflicts) {
  const out = { ...record }
  for (const { path, local } of conflicts ?? []) {
    if (!Array.isArray(path) || path.length === 0) continue
    if (path.length === 1) {
      if (local === undefined) delete out[path[0]]
      else out[path[0]] = local
      continue
    }
    const [field, key, sub] = path
    const list = out[field]
    if (!Array.isArray(list) || sub === undefined) continue
    const at = indexList(out.kind, field, list).keys.indexOf(key)
    if (at === -1) continue
    const el = { ...list[at] }
    if (local === undefined) delete el[sub]
    else el[sub] = local
    const next = [...list]
    next[at] = el
    out[field] = next
  }
  return out
}
