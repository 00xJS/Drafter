import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/*
 * What public.record_kinds holds, worked out from the migrations alone.
 *
 * Since v3.31 (20261008000000) that table is the database's list of record
 * kinds: sync_posts stores what it lists, and the posts policy and account
 * deletion read who may see each. Only migrations write it, so it holds what
 * their statements on it add up to, in order: the seed, then every insert
 * after it. This replays them, so a kind added the documented way — one insert
 * migration — is understood with no test to edit.
 *
 * Anything else a migration does to the table (an update, a delete, a policy,
 * an upsert) throws rather than being skipped: a replay that quietly misread
 * the table would hold the code to the wrong list.
 */

export interface KindFacts {
  /** Every row of the kind is its owner's alone, even inside a household. */
  personal: boolean
  /** Null when the kind's audience is not decided per record; otherwise what a row without `shared` means. */
  sharedDefault: boolean | null
}

export interface Migration {
  file: string
  sql: string
}

const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url))

/** Every migration, in the order they apply. */
export function readMigrations(): Migration[] {
  return readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(file => ({ file, sql: readFileSync(dir + file, 'utf8') }))
}

/** A migration's top-level statements, whitespace collapsed, with comments and dollar-quoted bodies (functions, DO blocks) left out. */
export function topLevelStatements(sql: string): string[] {
  const bare = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, '$$$$')
  return bare
    .split(';')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

const COLUMNS = new Set(['kind', 'personal', 'shared_default'])
const SHAPE_ONLY = [
  /^create table (if not exists )?(public\.)?record_kinds\b/i,
  /^alter table (public\.)?record_kinds enable row level security$/i,
  /^(grant|revoke) .* on (table )?(public\.)?record_kinds (to|from) /i,
  /^comment on (table|column) (public\.)?record_kinds\b/i,
]
const INSERT = /^insert into (?:public\.)?record_kinds ?\(([^)]*)\) ?values ?(.*?)( on conflict(?: ?\( ?kind ?\))? do nothing)?$/i
const TUPLE = /^\(([^()]*)\) ?(?:, ?|$)/

type Value = string | boolean | null | undefined

/** One literal of a VALUES tuple; undefined is DEFAULT. */
function literal(token: string, where: string): Value {
  const t = token.trim()
  if (/^'[^']*'$/.test(t)) return t.slice(1, -1)
  if (/^true$/i.test(t)) return true
  if (/^false$/i.test(t)) return false
  if (/^null$/i.test(t)) return null
  if (/^default$/i.test(t)) return undefined
  throw new Error(`${where}: cannot read the value ${t} in an insert into record_kinds`)
}

/** Replay `migrations` in order and return what record_kinds holds after them. */
export function recordKindsFrom(migrations: Migration[]): Map<string, KindFacts> {
  const kinds = new Map<string, KindFacts>()
  let created = false
  for (const { file, sql } of migrations) {
    for (const statement of topLevelStatements(sql)) {
      if (!/\brecord_kinds\b/i.test(statement)) continue
      if (SHAPE_ONLY[0].test(statement)) {
        created = true
        continue
      }
      if (SHAPE_ONLY.some(re => re.test(statement))) continue
      const m = INSERT.exec(statement)
      if (!m) throw new Error(`${file}: a statement on record_kinds this replay cannot read — teach src/__tests__/recordkinds.ts or write it as an insert: ${statement.slice(0, 160)}`)
      if (!created) throw new Error(`${file}: inserts into record_kinds before any migration creates it`)
      const columns = m[1].split(',').map(c => c.trim().toLowerCase())
      if (!columns.includes('kind') || columns.some(c => !COLUMNS.has(c)) || new Set(columns).size !== columns.length) {
        throw new Error(`${file}: an insert into record_kinds with columns (${m[1]})`)
      }
      const skipDuplicates = !!m[3]
      let rest = m[2].trim()
      if (!rest) throw new Error(`${file}: an insert into record_kinds with no rows`)
      while (rest) {
        const t = TUPLE.exec(rest)
        if (!t) throw new Error(`${file}: cannot read the rows of an insert into record_kinds at: ${rest.slice(0, 80)}`)
        rest = rest.slice(t[0].length).trim()
        const values = t[1].split(',')
        if (values.length !== columns.length) throw new Error(`${file}: a record_kinds row (${t[1]}) does not match its columns`)
        const row = Object.fromEntries(columns.map((c, i) => [c, literal(values[i], file)])) as Record<string, Value>
        const kind = row.kind
        if (typeof kind !== 'string' || !/^[a-z][a-z0-9_]*$/.test(kind)) throw new Error(`${file}: ${String(kind)} is not a kind record_kinds would take`)
        const personal = row.personal === undefined ? false : row.personal
        const sharedDefault = row.shared_default === undefined ? null : row.shared_default
        if (typeof personal !== 'boolean') throw new Error(`${file}: ${kind}'s personal must be true or false`)
        if (sharedDefault !== null && typeof sharedDefault !== 'boolean') throw new Error(`${file}: ${kind}'s shared_default must be true, false or null`)
        // the table's own check: a personal kind is nobody else's whatever a row says
        if (personal && sharedDefault !== null) throw new Error(`${file}: ${kind} is personal and per record at once, which record_kinds refuses`)
        if (kinds.has(kind)) {
          if (skipDuplicates) continue
          throw new Error(`${file}: inserts ${kind} into record_kinds a second time without on conflict do nothing`)
        }
        kinds.set(kind, { personal, sharedDefault })
      }
    }
  }
  return kinds
}

/** What record_kinds holds once every migration in supabase/migrations has applied. */
export function recordKinds(): Map<string, KindFacts> {
  return recordKindsFrom(readMigrations())
}
