import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { keyHeaders } from '../../netlify/functions/lib/supabasekeys.mjs'
import type { Stack } from './lane'

// The local stack as the lane reaches it without a browser: accounts through
// GoTrue's admin API with the service key, and everything else in SQL, with
// psql against the stack's own Postgres. Netlify's functions do not run in
// this lane, so what they would have written (a household, above all) is
// written here the way they write it.

/** One account on the local stack, and the password its browser signs in with. */
export interface Member {
  id: string
  email: string
  password: string
  /** What the household calls them: the part of the address before the @, as /api/household does. */
  name: string
}

/** A value as a SQL literal. Only the lane's own values go through here, never anything a page sent. */
export function lit(value: string | number | boolean | null): string {
  if (value === null) return 'null'
  if (typeof value !== 'string') return String(value)
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Run SQL as the database's owner and give back what it printed: unaligned,
 * no headers, so a single value comes back as itself. A statement that fails
 * rejects with psql's own words.
 */
export function sql(stack: Stack, query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const psql = spawn('psql', [stack.dbUrl, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    psql.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk))
    psql.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk))
    psql.on('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'ENOENT' ? new Error('psql is not on PATH: the cloud lane sets its households up in SQL (apt install postgresql-client, or brew install libpq)') : e),
    )
    psql.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error(`psql: ${err.trim() || `exited ${code}`}`))))
    psql.stdin.end(query)
  })
}

/** A query whose one value is JSON; null when it found nothing. */
export async function sqlJson<T>(stack: Stack, query: string): Promise<T> {
  const out = await sql(stack, query)
  return JSON.parse(out || 'null') as T
}

/**
 * Run SQL as `member` would through the Data API: the authenticated role and
 * their id in the request's claims, so every policy asks of it what it asks
 * of them. Rolled back, whatever it did.
 */
export function sqlAs(stack: Stack, member: Member, query: string): Promise<string> {
  const claims = JSON.stringify({ sub: member.id, email: member.email, role: 'authenticated', aud: 'authenticated' })
  return sql(stack, `begin;\nset local role authenticated;\nset local request.jwt.claims to ${lit(claims)};\n${query};\nrollback;`)
}

/** GoTrue's admin API with the service key, the way /api/admin makes an account. */
async function admin(stack: Stack, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${stack.url}/auth/v1/admin/${path}`, { ...init, headers: keyHeaders(stack.serviceKey, { 'content-type': 'application/json' }) })
  const body = (await res.json().catch(() => null)) as { msg?: string; message?: string; error?: string } | null
  if (!res.ok) throw new Error(`GoTrue admin ${path}: ${res.status} ${body?.msg ?? body?.message ?? body?.error ?? ''}`.trim())
  return body
}

/** A new account, confirmed, with a password of its own. Every test makes its own, so no two share a row. */
export async function createMember(stack: Stack, label: string): Promise<Member> {
  const name = `${label.toLowerCase()}-${randomUUID().slice(0, 8)}`
  // confirmed here, so no mail is ever sent to it
  const email = `${name}@example.com`
  const password = `pw-${randomUUID()}`
  const user = (await admin(stack, 'users', { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true }) })) as { id?: string; user?: { id?: string } }
  const id = user.id ?? user.user?.id
  if (!id) throw new Error(`GoTrue made ${email} without saying its id`)
  return { id, email, password, name }
}

/**
 * One household of these members, the first its owner — what Settings →
 * Household → Create, Add and the other member's Accept leave behind
 * (netlify/functions/household.mjs), written straight into its tables.
 */
export function makeHousehold(stack: Stack, owner: Member, ...others: Member[]): Promise<string> {
  const rows = [`((select id from made), ${lit(owner.id)}::uuid, 'owner')`, ...others.map(m => `((select id from made), ${lit(m.id)}::uuid, 'member')`)]
  return sql(
    stack,
    `with made as (insert into public.households (name, created_by) values ('Home', ${lit(owner.id)}::uuid) returning id),
          joined as (insert into public.household_members (household_id, user_id, role) values ${rows.join(', ')} returning household_id)
     select distinct household_id from joined;`,
  )
}

/** A stored row as the server holds it: whose it is, its stamp and its data. */
export interface ServerRow {
  id: string
  user_id: string
  updated_at: string
  data: Record<string, unknown>
}

/**
 * The newest row of `kind` owned by one of `owners` whose data says `field` is
 * `value`. Owners, because the stack outlives a test: a retry, or a second run
 * against the same stack, writes the same titles under accounts of its own.
 */
export function serverRow(stack: Stack, owners: readonly Member[], kind: string, field: string, value: string): Promise<ServerRow | null> {
  return sqlJson<ServerRow | null>(
    stack,
    `select row_to_json(p) from (
       select id, user_id, updated_at, data from public.posts
        where kind = ${lit(kind)} and data ->> ${lit(field)} = ${lit(value)}
          and user_id in (${owners.map(m => `${lit(m.id)}::uuid`).join(', ') || 'null'})
        order by updated_at desc limit 1) p;`,
  )
}
