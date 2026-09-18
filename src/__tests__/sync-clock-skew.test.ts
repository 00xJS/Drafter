import { describe, expect, it } from 'vitest'
import { applySync } from '../itemops'
import type { Item, Task } from '../types'

// A device whose clock runs fast used to lose every peer edit made inside the
// skew window, permanently and without a word.
//
// sync_posts refuses an updatedAt more than five minutes ahead of its own
// clock and stores now() instead (20260923000000_v3_14_wardrobe.sql). The echo
// came back with an EARLIER stamp than the copy the device still held, the
// merge kept the newer one — ours — and the two diverged for good. A peer's
// later edit then lost to a stamp that only existed on one device, and the
// cursor had already moved past it, so it was never offered again.
//
// The FakeServer in sync-fakes.ts does not model the clamp, so nothing in the
// suite covered this. These drive applySync directly, with the clamp in hand.

const task = (id: string, title: string, updatedAt: string): Task =>
  ({ kind: 'task', id, title, status: 'todo', priority: 'normal', createdAt: '2026-09-17T09:00:00.000Z', updatedAt }) as Task

/** What the server does to a stamp it will not take: keeps the content, stamps its own clock. */
const clampedEcho = (t: Task, at: string): Item => ({ ...t, updatedAt: at, syncedAt: at }) as Item

const FAST = '2026-09-17T10:20:00.000Z' // the fast device's idea of now
const REAL = '2026-09-17T10:00:00.000Z' // the server's
const PEER = '2026-09-17T10:02:00.000Z' // another device, two minutes later

describe('a stamp the server rewrote', () => {
  it('is adopted, so the device and the server agree on what it holds', () => {
    const mine = task('a', 'A edit', FAST)
    const out = applySync([mine], [mine], [clampedEcho(mine, REAL)], 'since', [], true, { dirty: new Set(['a']) })
    expect(out.merged.find(i => i.id === 'a')?.updatedAt).toBe(REAL)
    expect((out.merged.find(i => i.id === 'a') as Task).title).toBe('A edit')
    expect(out.accepted).toContain('a')
  })

  it("keeps what was typed here since the push, rather than standing on the server's echo", () => {
    // the push carried "A edit"; the box has said "A edit, again" since
    const sent = task('a', 'A edit', FAST)
    const newer = task('a', 'A edit, again', '2026-09-17T10:25:00.000Z')
    const out = applySync([newer], [sent], [clampedEcho(sent, REAL)], 'since', [], true, { dirty: new Set(['a']) })
    const got = out.merged.find(i => i.id === 'a') as Task
    expect(got.title).toBe('A edit, again')
    expect(got.updatedAt).toBe('2026-09-17T10:25:00.000Z')
  })

  it('leaves a row alone when the server echoed something else, which is a real conflict and not a clamp', () => {
    const mine = task('a', 'A edit', FAST)
    const theirs = task('a', 'B edit', REAL)
    const out = applySync([mine], [mine], [theirs as Item], 'since', [], true, { dirty: new Set(['a']) })
    // not a rewritten stamp: the content differs, so the ordinary rules decide
    expect((out.merged.find(i => i.id === 'a') as Task).title).not.toBe('A edit, again')
  })

  it('the peer edit that used to be dropped now lands', () => {
    // Round 1: the fast device pushes, the server clamps, the device adopts.
    const mine = task('a', 'A edit', FAST)
    const first = applySync([mine], [mine], [clampedEcho(mine, REAL)], 'since', [], true, { dirty: new Set(['a']) })
    const afterPush = first.merged as Task[]
    expect(afterPush.find(i => i.id === 'a')?.updatedAt).toBe(REAL)

    // Round 2: the other device's 10:02 edit arrives. Nothing is dirty here now.
    const peer = task('a', 'B edit', PEER)
    const second = applySync(afterPush, [], [peer as Item], REAL, [], true, { dirty: new Set() })
    expect((second.merged.find(i => i.id === 'a') as Task).title).toBe('B edit')
  })

  it('without the adoption the same peer edit is lost — which is what made this worth fixing', () => {
    // the device kept its own future stamp, so 10:02 is not "newer" and the
    // merge throws the peer's edit away while the cursor moves past it
    const stillFast = [task('a', 'A edit', FAST)] as Item[]
    const peer = task('a', 'B edit', PEER)
    const out = applySync(stillFast, [], [peer as Item], REAL, [], true, { dirty: new Set() })
    expect((out.merged.find(i => i.id === 'a') as Task).title).toBe('A edit')
    expect(out.cursor).toBe(PEER)
  })
})
