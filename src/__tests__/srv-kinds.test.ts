import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PERSONAL_KINDS, SYNC_KINDS, kindOf, readableKind, readableRow } from '../../shared/kinds.mjs'
import { visibleItemsFor } from '../../shared/digest.mjs'
import { KINDS } from '../../netlify/functions/lib/datastats.mjs'
import { KNOWN_KINDS } from '../schema'

// shared/kinds.mjs is the one list: the app, the digest and the server-side
// readers all import it. What can't import it — the kind lists written into
// migrations, and the Admin tallies — is held to it here, and the app is held
// to importing rather than keeping a copy. A personal kind the policy forgets
// is how habits and routines reached a household peer's device through v3.9.

const root = new URL('../../', import.meta.url)
const dir = fileURLToPath(new URL('supabase/migrations/', root))
const migrations = readdirSync(dir)
  .filter(f => f.endsWith('.sql'))
  .sort()
  .map(f => ({ f, sql: readFileSync(dir + f, 'utf8') }))
const sorted = (xs: Iterable<string>) => [...xs].sort()

/** The newest migration whose text matches `declares`. */
function newestFile(declares: RegExp): string {
  for (const { sql } of [...migrations].reverse()) if (declares.test(sql)) return sql
  throw new Error(`no migration matches ${declares}`)
}

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
  it('matches the newest posts policy', () => {
    const posts = newest(/create policy "household access" on public\.posts\b/, /create policy "household access" on public\.posts\b[\s\S]*?not in \(([^)]*)\)/)
    expect(sorted(posts)).toEqual(sorted(PERSONAL_KINDS))
  })

  it('does not apply to posts_history, which is the owner\'s alone', () => {
    // A version's audience cannot be decided after the fact without re-deciding
    // every version — share a note edited privately for a fortnight and each
    // draft would go with it — and VersionsPanel.tsx fetches this table straight
    // from the client with the reader's JWT. So there is no kind list here any
    // more: your own rows, and nothing else.
    const sql = newestFile(/create policy "household history select" on public\.posts_history/)
    const policy = sql.slice(sql.indexOf('create policy "household history select"'))
    const body = policy.slice(0, policy.indexOf(';') + 1)
    expect(body).toContain('using (user_id = auth.uid())')
    expect(body).not.toContain('household_user_ids')
    expect(body).not.toContain('not in (')
  })

  it('matches what account deletion treats as personal', () => {
    const deletion = newest(/create or replace function public\.admin_prepare_user_deletion/, /personal constant text\[\] := array\[([^\]]*)\]/)
    expect(sorted(deletion)).toEqual(sorted(PERSONAL_KINDS))
  })

  it('is what the app reads too — imported, never copied', () => {
    const src = (p: string) => readFileSync(fileURLToPath(new URL(p, root)), 'utf8')
    const store = src('src/store.ts')
    const schema = src('src/schema.ts')
    expect(store).toMatch(/import \{[^}]*\bPERSONAL_KINDS\b[^}]*\} from '\.\.\/shared\/kinds\.mjs'/)
    expect(schema).toMatch(/import \{[^}]*\bSYNC_KINDS\b[^}]*\} from '\.\.\/shared\/kinds\.mjs'/)
    // a second hand-written list is how the copies drifted before
    for (const [file, text] of [['src/store.ts', store], ['src/schema.ts', schema]]) {
      expect(text, `${file} keeps its own kinds list again`).not.toMatch(/new Set\(\[\s*'(task|journal)'/)
    }
  })

  it('is a subset of the kinds the server stores', () => {
    expect([...PERSONAL_KINDS].filter(k => !SYNC_KINDS.has(k))).toEqual([])
  })

  it('is what the digest hides from a household peer, and — with an unshared note — nothing more', () => {
    const rows = [...SYNC_KINDS].map(kind => ({ user_id: 'peer', data: { kind, id: `peer-${kind}` } }))
    const seen = (visibleItemsFor(rows, 'me', ['me', 'peer'], 'me') as { kind: string }[]).map(i => i.kind)
    // 'note' is not a personal kind — a shared one is genuinely the
    // household's — but a note carries its own audience, and these carry no
    // `shared`, so none of them is this reader's to see (v3.16)
    expect(sorted(seen)).toEqual(sorted([...SYNC_KINDS].filter(k => !PERSONAL_KINDS.has(k) && k !== 'note')))
    const mine = [...PERSONAL_KINDS].map(kind => ({ user_id: 'me', data: { kind, id: `me-${kind}` } }))
    expect(visibleItemsFor(mine, 'me', ['me', 'peer'], 'me')).toHaveLength(PERSONAL_KINDS.size)
  })

  it('treats a meal as the household\'s, like grocery — v3.21, after the id carries the member', () => {
    expect(PERSONAL_KINDS.has('meal')).toBe(false)
    expect(readableKind('meal', 'peer', 'me')).toBe(true)
    expect(readableKind('grocery', 'peer', 'me')).toBe(true)
  })

  it('lets a meal be kept to yourself the way a task can — v3.22', () => {
    expect(readableRow({ kind: 'meal' }, 'peer', 'me')).toBe(true)
    expect(readableRow({ kind: 'meal', shared: true }, 'peer', 'me')).toBe(true)
    expect(readableRow({ kind: 'meal', shared: false }, 'peer', 'me')).toBe(false)
    expect(readableRow({ kind: 'meal', shared: false }, 'me', 'me')).toBe(true)
  })

  it('leaves the note rule to the record: shared reaches a peer, and the kind list never mentions it', () => {
    const shared = [{ user_id: 'peer', data: { kind: 'note', id: 'peer-note', shared: true } }]
    expect((visibleItemsFor(shared, 'me', ['me', 'peer'], 'me') as { id: string }[]).map(i => i.id)).toEqual(['peer-note'])
    expect(PERSONAL_KINDS.has('note')).toBe(false)
  })
})

describe('readableRow is the whole posts policy, for the readers that bypass it', () => {
  it('answers the kind question exactly as readableKind does', () => {
    for (const kind of SYNC_KINDS) {
      if (kind === 'note') continue
      expect(readableRow({ kind }, 'peer', 'me'), kind).toBe(readableKind(kind, 'peer', 'me'))
      expect(readableRow({ kind }, 'me', 'me'), kind).toBe(readableKind(kind, 'me', 'me'))
    }
  })

  it('and the record question a kind cannot answer: a note is its owner’s until `shared` is true', () => {
    expect(readableRow({ kind: 'note' }, 'peer', 'me')).toBe(false)
    expect(readableRow({ kind: 'note', shared: true }, 'peer', 'me')).toBe(true)
    // your own, always — the flag says who else may read it, not whether you may
    expect(readableRow({ kind: 'note' }, 'me', 'me')).toBe(true)
  })

  it('and the same question of a meal, whose default matches a task', () => {
    expect(readableRow({ kind: 'meal' }, 'peer', 'me')).toBe(true)
    expect(readableRow({ kind: 'meal', shared: true }, 'peer', 'me')).toBe(true)
    expect(readableRow({ kind: 'meal', shared: false }, 'peer', 'me')).toBe(false)
    expect(readableRow({ kind: 'meal', shared: false }, 'me', 'me')).toBe(true)
  })

  it('and the same question of a task, whose default is the other way round', () => {
    // v3.19: household work unless its owner withheld it, so an absent flag —
    // which is every task written before then — stays the household's
    expect(readableRow({ kind: 'task' }, 'peer', 'me')).toBe(true)
    expect(readableRow({ kind: 'task', shared: true }, 'peer', 'me')).toBe(true)
    expect(readableRow({ kind: 'task', shared: false }, 'peer', 'me')).toBe(false)
    expect(readableRow({ kind: 'task', shared: false }, 'me', 'me')).toBe(true)
    // a legacy row with no kind at all is a task, and reads as one here too
    expect(readableRow({ id: 'legacy' }, 'peer', 'me')).toBe(true)
  })

  it('is never more permissive than the policy, whatever a hand-written row carries', () => {
    // the policy compares TEXT (`data ->> 'shared' = 'true'`), so a stray value
    // is not 'true' and withholds a note; for a task anything that is not
    // 'true' withholds it too. Erring this way can only hide a row, never
    // serve one the database would not.
    for (const stray of ['true', 'false', 1, 0, {}, ['yes']]) {
      expect(readableRow({ kind: 'task', shared: stray }, 'peer', 'me'), String(stray)).toBe(false)
      expect(readableRow({ kind: 'note', shared: stray }, 'peer', 'me'), String(stray)).toBe(false)
    }
  })

  it('matches the newest posts policy, which is where it is really enforced', () => {
    const sql = newestFile(/create policy "household access" on public\.posts\b/)
    expect(sql).toMatch(/<> 'note' or coalesce\(data ->> 'shared', 'false'\) = 'true'/)
    expect(sql).toMatch(/<> 'task' or coalesce\(data ->> 'shared', 'true'\) = 'true'/)
    expect(sql).toMatch(/<> 'meal' or coalesce\(data ->> 'shared', 'true'\) = 'true'/)
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
