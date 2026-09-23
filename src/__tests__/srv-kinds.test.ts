import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PERSONAL_KINDS, SHARED_BY_DEFAULT, SYNC_KINDS, kindOf, readableKind, readableRow } from '../../shared/kinds.mts'
import { visibleItemsFor } from '../../shared/digest.mts'
import { KINDS } from '../../netlify/functions/lib/datastats.mjs'
import { KNOWN_KINDS } from '../schema'
import { readMigrations, recordKinds, recordKindsFrom, type Migration } from './recordkinds'

// shared/kinds.mts is the code's one list: the app, the digest and the
// server-side readers all import it. The database's is public.record_kinds
// (v3.31), which sync_posts, the posts policy and account deletion all read;
// recordKinds() replays the migrations that fill it, so a kind added by an
// insert is held to this file with no test to edit. The Admin tallies are held
// here too, and the app is held to importing rather than keeping a copy. A
// personal kind the policy forgets is how habits and routines reached a
// household peer's device through v3.9.

const root = new URL('../../', import.meta.url)
const migrations = readMigrations()
const kinds = recordKinds()
const sorted = (xs: Iterable<string>) => [...xs].sort()

/** The newest of `among` whose text matches `declares`. */
function newestFile(declares: RegExp, among: Migration[] = migrations): Migration {
  for (const m of [...among].reverse()) if (declares.test(m.sql)) return m
  throw new Error(`no migration matches ${declares}`)
}

/** The quoted kinds in the newest of `among` matching `declares`, taken from the first group of `list`. */
function newest(declares: RegExp, list: RegExp, among: Migration[] = migrations): string[] {
  const { file, sql } = newestFile(declares, among)
  const m = list.exec(sql)
  if (!m) throw new Error(`${file} matches ${declares} but has no kind list`)
  return [...m[1].matchAll(/'([a-z]+)'/g)].map(x => x[1])
}

/** The text of one definition in the newest migration that makes it: from `starts` to the first `ends` after it. */
function newestDefinition(starts: RegExp, ends: string): string {
  const { sql } = newestFile(starts)
  const from = sql.search(starts)
  return sql.slice(from, sql.indexOf(ends, from) + ends.length)
}

describe('SYNC_KINDS is every kind the server stores', () => {
  it('matches the client’s KNOWN_KINDS, record_kinds and the Admin tallies', () => {
    expect(sorted(SYNC_KINDS)).toEqual(sorted(KNOWN_KINDS))
    expect(sorted(SYNC_KINDS)).toEqual(sorted(kinds.keys()))
    expect(sorted(KINDS)).toEqual(sorted(SYNC_KINDS))
  })
})

describe('record_kinds is the database’s one list', () => {
  it('was seeded with exactly what the database enforced before it — no kind lost, gained or re-decided', () => {
    // The v3.31 refactor, held from the files as the migration's own guard
    // holds it against the live database: the seed against the newest
    // allowlist, personal list and per-record clauses written out before it.
    const seeding = migrations.findIndex(m => /create table if not exists public\.record_kinds\b/.test(m.sql))
    expect(seeding, 'the migration that creates record_kinds').toBeGreaterThan(0)
    const before = migrations.slice(0, seeding)
    const seed = recordKindsFrom(migrations.slice(0, seeding + 1))
    expect(sorted(seed.keys())).toEqual(sorted(newest(/create or replace function public\.sync_posts/, /item_kind in \(([^)]*)\)/, before)))
    const policy = newestFile(/create policy "household access" on public\.posts\b/, before).sql
    const personal = newest(/create policy "household access" on public\.posts\b/, /create policy "household access" on public\.posts\b[\s\S]*?not in \(([^)]*)\)/, before)
    expect(sorted([...seed].filter(([, f]) => f.personal).map(([k]) => k))).toEqual(sorted(personal))
    expect(sorted(newest(/create or replace function public\.admin_prepare_user_deletion/, /personal constant text\[\] := array\[([^\]]*)\]/, before))).toEqual(sorted(personal))
    const perRecord = Object.fromEntries(
      [...policy.slice(policy.indexOf('create policy "household access"')).matchAll(/<> '([a-z]+)' or coalesce\(data ->> 'shared', '(true|false)'\) = 'true'/g)]
        .map(m => [m[1], m[2] === 'true']),
    )
    expect(Object.fromEntries([...seed].filter(([, f]) => f.sharedDefault !== null).map(([k, f]) => [k, f.sharedDefault]))).toEqual(perRecord)
  })

  it('is what sync_posts, the posts policy, account deletion and the flag trigger read — none keeps a list again', () => {
    // A definition copied from a migration older than v3.31 brings its list
    // back, and a kind then added by an insert is refused, or seen, by that
    // one place. db:smoke catches it by behaviour; this catches it first.
    const syncPosts = newestDefinition(/create or replace function public\.sync_posts\b/, '$$;')
    expect(syncPosts).toContain('public.record_kind_allowed(item_kind)')
    expect(syncPosts).not.toMatch(/item_kind in \(/)
    const policy = newestDefinition(/create policy "household access" on public\.posts\b/, ');\n')
    expect(policy).toContain('public.record_peer_visible(')
    expect(policy).toContain('public.record_shared(')
    expect(policy).not.toMatch(/not in \(|<> '[a-z]+'/)
    const deletion = newestDefinition(/create or replace function public\.admin_prepare_user_deletion\b/, '$$;')
    expect(deletion).toContain('public.record_peer_visible(')
    expect(deletion).not.toMatch(/array\['|in \('/)
    const flag = newestDefinition(/create or replace function public\.posts_private_flag\b/, '$$;')
    expect(flag).toContain('public.record_kind_shared_default(')
    expect(flag).not.toMatch(/in \('/)
  })
})

describe('PERSONAL_KINDS is what the database keeps to its owner', () => {
  it('matches record_kinds', () => {
    expect(sorted([...kinds].filter(([, f]) => f.personal).map(([k]) => k))).toEqual(sorted(PERSONAL_KINDS))
  })

  it('does not apply to posts_history, which is the owner\'s alone', () => {
    // A version's audience cannot be decided after the fact without re-deciding
    // every version — share a note edited privately for a fortnight and each
    // draft would go with it — and VersionsPanel.tsx fetches this table straight
    // from the client with the reader's JWT. So there is no kind list here any
    // more: your own rows, and nothing else.
    const { sql } = newestFile(/create policy "household history select" on public\.posts_history/)
    const policy = sql.slice(sql.indexOf('create policy "household history select"'))
    const body = policy.slice(0, policy.indexOf(';') + 1)
    expect(body).toContain('using (user_id = auth.uid())')
    expect(body).not.toContain('household_user_ids')
    expect(body).not.toContain('not in (')
  })

  it('is what the app reads too — imported, never copied', () => {
    const src = (p: string) => readFileSync(fileURLToPath(new URL(p, root)), 'utf8')
    const store = src('src/store.ts')
    const schema = src('src/schema.ts')
    expect(store).toMatch(/import \{[^}]*\bPERSONAL_KINDS\b[^}]*\} from '\.\.\/shared\/kinds\.mts'/)
    expect(schema).toMatch(/import \{[^}]*\bSYNC_KINDS\b[^}]*\} from '\.\.\/shared\/kinds\.mts'/)
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

  it('matches record_kinds, which the posts policy reads and where it is really enforced', () => {
    const perRecord = Object.fromEntries([...kinds].filter(([, f]) => f.sharedDefault !== null).map(([k, f]) => [k, f.sharedDefault]))
    expect(perRecord).toEqual({ ...SHARED_BY_DEFAULT })
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
