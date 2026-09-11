import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KNOWN_KINDS } from '../schema'

// A kind the client knows but the server does not is the worst kind of bug:
// sync_posts rejects the row, RETRY_KINDS re-pushes it forever, and the record
// sits on one device looking saved. 'habit' and 'routine' both shipped that way.
// This holds the newest migration that declares sync_posts to the client's list.

const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url))

/** The kind allowlist from the last migration that (re)declares sync_posts. */
function serverKinds(): string[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
  for (const f of [...files].reverse()) {
    const sql = readFileSync(dir + f, 'utf8')
    if (!/create or replace function public\.sync_posts/.test(sql)) continue
    const m = /kind in \(([^)]*)\)/.exec(sql)
    if (!m) throw new Error(`${f} declares sync_posts without a kind allowlist`)
    return [...m[1].matchAll(/'([a-z]+)'/g)].map(x => x[1])
  }
  throw new Error('no migration declares sync_posts')
}

describe('the server accepts every kind the client can write', () => {
  it('lists each of KNOWN_KINDS in the newest sync_posts allowlist', () => {
    const server = new Set(serverKinds())
    const missing = [...KNOWN_KINDS].filter(k => !server.has(k))
    expect(missing, 'add a migration re-declaring sync_posts with these kinds').toEqual([])
  })
})
