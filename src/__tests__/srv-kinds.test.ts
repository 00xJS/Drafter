import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PERSONAL_KINDS, SYNC_KINDS, kindOf, readableKind } from '../../shared/kinds.mjs'
import { visibleItemsFor } from '../../shared/digest.mjs'
import { KINDS } from '../../netlify/functions/lib/datastats.mjs'
import { KNOWN_KINDS } from '../schema'

// shared/kinds.mjs is the one list the server-side readers use. Until the app
// imports it too, every other copy is held to it here: the client's two sets,
// the digest's visibility mirror, and the kind lists written into migrations.
// A personal kind the policy forgets is how habits and routines reached a
// household peer's device through v3.9.

const root = new URL('../../', import.meta.url)
const dir = fileURLToPath(new URL('supabase/migrations/', root))
const migrations = readdirSync(dir)
  .filter(f => f.endsWith('.sql'))
  .sort()
  .map(f => ({ f, sql: readFileSync(dir + f, 'utf8') }))
const sorted = (xs: Iterable<string>) => [...xs].sort()

/** The quoted kinds in the newest migration matching `declares`, taken from the first group of `list`. */
function newest(declares: RegExp, list: RegExp): string[] {
  for (const { f, sql } of [...migrations].reverse()) {
    if (!declares.test(sql)) continue
    const m = list.exec(sql)
    if (!m) throw new Error(`${f} matches ${declares} but has no kind list`)
    return [...m[1].matchAll(/'([a-z]+)'/g)].map(x => x[1])
  }
  throw new Error(`no migration matches ${declares}`)
}

describe('SYNC_KINDS is every kind the server stores', () => {
  it('matches the client’s KNOWN_KINDS, the newest sync_posts allowlist and the Admin tallies', () => {
    expect(sorted(SYNC_KINDS)).toEqual(sorted(KNOWN_KINDS))
    expect(sorted(SYNC_KINDS)).toEqual(sorted(newest(/create or replace function public\.sync_posts/, /kind in \(([^)]*)\)/)))
    expect(sorted(KINDS)).toEqual(sorted(SYNC_KINDS))
  })
})

describe('PERSONAL_KINDS is what the database keeps to its owner', () => {
  it('matches the newest posts policy and posts_history policy', () => {
    const posts = newest(/create policy "household access" on public\.posts\b/, /create policy "household access" on public\.posts\b[\s\S]*?not in \(([^)]*)\)/)
    const history = newest(
      /create policy "household history select" on public\.posts_history/,
      /create policy "household history select" on public\.posts_history[\s\S]*?not in \(([^)]*)\)/,
    )
    expect(sorted(posts)).toEqual(sorted(PERSONAL_KINDS))
    expect(sorted(history)).toEqual(sorted(PERSONAL_KINDS))
  })

  it('matches what account deletion treats as personal', () => {
    const deletion = newest(/create or replace function public\.admin_prepare_user_deletion/, /personal constant text\[\] := array\[([^\]]*)\]/)
    expect(sorted(deletion)).toEqual(sorted(PERSONAL_KINDS))
  })

  it('matches the client’s own set in src/store.ts', () => {
    const store = readFileSync(fileURLToPath(new URL('src/store.ts', root)), 'utf8')
    const m = /const PERSONAL_KINDS = new Set\(\[([^\]]*)\]\)/.exec(store)
    expect(m, 'src/store.ts no longer declares PERSONAL_KINDS inline — import it from shared/kinds.mjs and drop this check').not.toBeNull()
    expect(sorted([...m![1].matchAll(/'([a-z]+)'/g)].map(x => x[1]))).toEqual(sorted(PERSONAL_KINDS))
  })

  it('is a subset of the kinds the server stores', () => {
    expect([...PERSONAL_KINDS].filter(k => !SYNC_KINDS.has(k))).toEqual([])
  })

  it('is what the digest hides from a household peer, and nothing more', () => {
    const rows = [...SYNC_KINDS].map(kind => ({ user_id: 'peer', data: { kind, id: `peer-${kind}` } }))
    const seen = (visibleItemsFor(rows, 'me', ['me', 'peer'], 'me') as { kind: string }[]).map(i => i.kind)
    expect(sorted(seen)).toEqual(sorted([...SYNC_KINDS].filter(k => !PERSONAL_KINDS.has(k))))
    const mine = [...PERSONAL_KINDS].map(kind => ({ user_id: 'me', data: { kind, id: `me-${kind}` } }))
    expect(visibleItemsFor(mine, 'me', ['me', 'peer'], 'me')).toHaveLength(PERSONAL_KINDS.size)
  })
})

describe('kindOf / readableKind', () => {
  it('reads a row with no kind as a task, the way coalesce(data->>kind, task) does', () => {
    expect(kindOf({ title: 'legacy post' })).toBe('task')
    expect(kindOf({ kind: null })).toBe('task')
    expect(kindOf(null)).toBe('task')
    expect(kindOf({ kind: 'habit' })).toBe('habit')
  })

  it('lets only the owner read a personal kind, and anyone read a shared one', () => {
    expect(readableKind('habit', 'me', 'me')).toBe(true)
    expect(readableKind('habit', 'peer', 'me')).toBe(false)
    expect(readableKind('routine', null, 'me')).toBe(false)
    expect(readableKind('journal', undefined, undefined)).toBe(false)
    expect(readableKind('task', 'peer', 'me')).toBe(true)
    expect(readableKind(undefined, 'peer', 'me')).toBe(true)
  })
})
