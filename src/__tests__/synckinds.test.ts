import { describe, expect, it } from 'vitest'
import { KNOWN_KINDS } from '../schema'
import { recordKinds } from './recordkinds'

// A kind the client knows but the server does not is the worst kind of bug:
// sync_posts rejects the row, the client re-pushes it forever, and the record
// sits on one device looking saved. 'habit' and 'routine' both shipped that way.
// Since v3.31 sync_posts stores whatever public.record_kinds lists, so this
// holds the client's list to that table, as its migrations fill it.

describe('the server accepts every kind the client can write', () => {
  it('lists each of KNOWN_KINDS in record_kinds', () => {
    const server = recordKinds()
    const missing = [...KNOWN_KINDS].filter(k => !server.has(k))
    expect(missing, 'add a migration inserting these into public.record_kinds').toEqual([])
  })
})
