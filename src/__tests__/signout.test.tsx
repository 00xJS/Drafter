import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { plannerSource } from './source'

// Signing out wipes this device (clearLocalData deletes the whole IndexedDB),
// so a photo that had not finished uploading — a piece of clothing's, a note's
// or a task's — was lost without a word. Every sign-out the person starts now
// asks first while one is waiting: "n photos haven't uploaded yet", with Try
// uploading now, Sign out anyway and Cancel. The media store and the sync
// engine are stand-ins.

const media = vi.hoisted(() => ({ count: 0 as number | Error, flushes: 0, rounds: 0 }))
vi.mock('../media', () => ({
  unsentPhotoCount: vi.fn(async () => {
    if (media.count instanceof Error) throw media.count
    return media.count
  }),
  flushPendingMedia: vi.fn(async () => {
    media.flushes++
    return 0
  }),
}))
vi.mock('../store', () => ({
  syncIfStarted: vi.fn(async () => {
    media.rounds++
    return true
  }),
}))

import { UnsentPhotosSheet, useSignOut } from '../components/SignOutGuard'
import {
  expiredLine,
  signOutAnyway,
  signOutFlow,
  startSignOut,
  unsentLine,
  UPLOAD_WAIT_MS,
  uploadThenSignOut,
  withMedia,
  type SignOutBusy,
  type SignOutSteps,
  type UnsentAsk,
} from '../signout'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const noop = () => {}
/** The footer's answers, in order: [class, label, disabled]. */
const answers = (html: string) => [...html.matchAll(/<button type="button" class="([^"]+)"( disabled="")?>([^<]+)<\/button>/g)].map(m => [m[1], m[3], !!m[2]])

afterEach(() => {
  vi.useRealTimers()
})

/** Steps whose counts come from a list, one per ask; the sign-out and the flush are recorded. */
function steps(counts: number[], flush: () => Promise<unknown> = async () => 0): SignOutSteps & { signOut: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> } {
  return { unsent: vi.fn(async () => counts.shift() ?? 0), flush: vi.fn(flush), signOut: vi.fn(async () => {}) }
}

describe('startSignOut: the first tap', () => {
  it('signs out at once when every photo is up', async () => {
    const s = steps([0])
    expect(await startSignOut(s)).toBeNull()
    expect(s.signOut).toHaveBeenCalledOnce()
    expect(s.flush).not.toHaveBeenCalled()
  })

  it('asks first while photos are waiting, and does nothing yet', async () => {
    const s = steps([3])
    expect(await startSignOut(s)).toEqual({ count: 3, tried: false })
    expect(s.signOut).not.toHaveBeenCalled()
  })
})

describe('uploadThenSignOut: Try uploading now', () => {
  it('sends what is waiting and carries on signing out once every photo is up', async () => {
    const s = steps([0])
    expect(await uploadThenSignOut(s)).toBeNull()
    expect(s.flush).toHaveBeenCalledOnce()
    expect(s.signOut).toHaveBeenCalledOnce()
  })

  it('asks again with what is left when some could not go', async () => {
    const s = steps([2])
    expect(await uploadThenSignOut(s)).toEqual({ count: 2, tried: true })
    expect(s.signOut).not.toHaveBeenCalled()
  })

  it('still counts when the upload itself throws', async () => {
    const s = steps([1], async () => {
      throw new Error('offline')
    })
    expect(await uploadThenSignOut(s)).toEqual({ count: 1, tried: true })
  })

  it('asks again once it has waited long enough on an upload that has stalled', async () => {
    vi.useFakeTimers()
    const s = steps([2], () => new Promise(() => {}))
    let answered = false
    const asked = uploadThenSignOut(s).finally(() => (answered = true))
    await vi.advanceTimersByTimeAsync(UPLOAD_WAIT_MS - 1)
    expect(answered).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await asked).toEqual({ count: 2, tried: true })
    expect(s.signOut).not.toHaveBeenCalled()
  })

  it('signs nobody out when Cancel came while it was uploading, even with every photo up', async () => {
    const cancel = new AbortController()
    const s = steps([0], async () => cancel.abort())
    expect(await uploadThenSignOut(s, cancel.signal)).toBeNull()
    expect(s.signOut).not.toHaveBeenCalled()
  })
})

describe('withMedia: the media store around a sign-out', () => {
  it('asks the store how many are waiting, and flushes it with a sync round for the edits the wipe would take too', async () => {
    media.count = 4
    const signOut = vi.fn(async () => {})
    expect(await startSignOut(withMedia(signOut))).toEqual({ count: 4, tried: false })
    media.count = 0
    const before = { flushes: media.flushes, rounds: media.rounds }
    expect(await uploadThenSignOut(withMedia(signOut))).toBeNull()
    expect(media.flushes).toBe(before.flushes + 1)
    expect(media.rounds).toBe(before.rounds + 1)
    expect(signOut).toHaveBeenCalledOnce()
  })

  it('never locks the way out: a count that can’t be read reads as none', async () => {
    media.count = new Error('IndexedDB is gone')
    const signOut = vi.fn(async () => {})
    expect(await startSignOut(withMedia(signOut))).toBeNull()
    expect(signOut).toHaveBeenCalledOnce()
    media.count = 0
  })
})

describe('signOutFlow: one answer at a time, and Cancel always gets out', () => {
  function flowOf(s: SignOutSteps) {
    const asks: (UnsentAsk | null)[] = []
    const busy: (SignOutBusy | null)[] = []
    return { asks, busy, flow: signOutFlow(() => s, { ask: a => void asks.push(a), busy: b => void busy.push(b) }) }
  }

  it('Cancel while an upload is tried closes the question at once, and the upload ending later neither reopens it nor signs out', async () => {
    let finish = () => {}
    const s = steps([2, 0], () => new Promise<void>(r => (finish = r)))
    const { asks, busy, flow } = flowOf(s)
    await flow.run('checking', startSignOut)
    expect(asks).toEqual([{ count: 2, tried: false }])
    const trying = flow.run('uploading', uploadThenSignOut)
    flow.cancel()
    expect(asks).toEqual([{ count: 2, tried: false }, null])
    expect(busy).toEqual(['checking', null, 'uploading', null])
    // every photo goes up after all, behind the closed question
    finish()
    await trying
    expect(s.signOut).not.toHaveBeenCalled()
    expect(asks).toEqual([{ count: 2, tried: false }, null])
    expect(busy).toEqual(['checking', null, 'uploading', null])
  })

  it('takes no second answer while one runs, and after a Cancel the next tap goes at once', async () => {
    vi.useFakeTimers()
    const s = steps([1], () => new Promise(() => {}))
    const { asks, flow } = flowOf(s)
    void flow.run('uploading', uploadThenSignOut)
    await flow.run('signing-out', signOutAnyway)
    expect(s.signOut).not.toHaveBeenCalled()
    flow.cancel()
    await flow.run('checking', startSignOut)
    expect(asks).toEqual([null, { count: 1, tried: false }])
  })
})

describe('the question', () => {
  it('says how many and what signing out does to them', () => {
    expect(unsentLine(3)).toBe('3 photos haven’t uploaded yet. Signing out deletes them from this device.')
    expect(unsentLine(1)).toBe('1 photo hasn’t uploaded yet. Signing out deletes it from this device.')
  })

  it('offers Sign out anyway, Cancel and Try uploading now, the safe answer last', () => {
    const html = renderToStaticMarkup(<UnsentPhotosSheet count={3} tried={false} busy={null} onUpload={noop} onSignOut={noop} onCancel={noop} />)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('Sign out?')
    expect(html).toContain('3 photos haven’t uploaded yet. Signing out deletes them from this device.')
    expect(answers(html)).toEqual([
      ['btn danger', 'Sign out anyway', false],
      ['btn', 'Cancel', false],
      ['btn primary', 'Try uploading now', false],
    ])
    expect(html).not.toContain('role="alert"')
  })

  it('says so when the upload just tried did not get them all up', () => {
    expect(renderToStaticMarkup(<UnsentPhotosSheet count={2} tried busy={null} onUpload={noop} onSignOut={noop} onCancel={noop} />)).toContain(
      '<p class="warn" role="alert">They couldn’t be uploaded just now. Check the connection, then try again.</p>',
    )
    expect(renderToStaticMarkup(<UnsentPhotosSheet count={1} tried busy={null} onUpload={noop} onSignOut={noop} onCancel={noop} />)).toContain('It couldn’t be uploaded just now.')
  })

  it('keeps Cancel while an upload is tried, and holds every answer only while signing out', () => {
    const uploading = renderToStaticMarkup(<UnsentPhotosSheet count={2} tried={false} busy="uploading" onUpload={noop} onSignOut={noop} onCancel={noop} />)
    expect(answers(uploading)).toEqual([
      ['btn danger', 'Sign out anyway', true],
      ['btn', 'Cancel', false],
      ['btn primary', 'Uploading…', true],
    ])
    const leaving = renderToStaticMarkup(<UnsentPhotosSheet count={2} tried={false} busy="signing-out" onUpload={noop} onSignOut={noop} onCancel={noop} />)
    expect(answers(leaving)).toEqual([
      ['btn danger', 'Signing out…', true],
      ['btn', 'Cancel', true],
      ['btn primary', 'Try uploading now', true],
    ])
    // Escape, the backdrop and ✕ are Cancel on the same terms
    const sheet = read('../components/SignOutGuard.tsx')
    expect(sheet).toContain('const leaving = busy === \'signing-out\'')
    expect(sheet).toContain('<Modal onClose={leaving ? () => {} : onCancel} className="modal narrow" closeOnBackdrop={!leaving}>')
  })

  it('after the session has expired, says nothing can be uploaded first and offers no try, Cancel being the answer that keeps them', () => {
    expect(expiredLine(3)).toBe('Your session has expired, so they can’t be uploaded first. Cancel keeps them on this device for now.')
    expect(expiredLine(1)).toBe('Your session has expired, so it can’t be uploaded first. Cancel keeps it on this device for now.')
    const html = renderToStaticMarkup(<UnsentPhotosSheet count={3} tried={false} expired busy={null} onUpload={noop} onSignOut={noop} onCancel={noop} />)
    expect(html).toContain(unsentLine(3))
    expect(html).toContain(expiredLine(3))
    expect(answers(html)).toEqual([
      ['btn danger', 'Sign out anyway', false],
      ['btn primary', 'Cancel', false],
    ])
    // never the connection's fault when the session is what is missing
    const one = renderToStaticMarkup(<UnsentPhotosSheet count={1} tried expired busy={null} onUpload={noop} onSignOut={noop} onCancel={noop} />)
    expect(one).toContain(expiredLine(1))
    expect(one).not.toContain('Check the connection')
  })

  it('stays closed until a sign-out asks it', () => {
    function Probe() {
      const s = useSignOut(async () => {})
      return (
        <button type="button" disabled={s.busy}>
          {s.question ? 'asking' : 'idle'}
        </button>
      )
    }
    expect(renderToStaticMarkup(<Probe />)).toBe('<button type="button">idle</button>')
  })
})

describe('every sign-out the person starts asks first', () => {
  it('Settings → Account: the whole sign-out runs only through the question, which knows when the session has expired', () => {
    const src = read('../components/settings/Household.tsx')
    expect(src).toMatch(/const signOut = useSignOut\(async \(\) => \{\s*await disablePush\(\)[\s\S]*?await getSupabase\(\)\?\.auth\.signOut\(\)\s*await clearLocalData\(\)/)
    expect(src).toContain('export function Account({ supabaseOn, onClose, store }: SettingsCtx)')
    expect(src).toMatch(/window\.location\.reload\(\)\s*\}, store\.syncInfo\.authError\)/)
    expect(src).toContain('onClick={signOut.start}')
    expect(src).toContain('{signOut.question}')
  })

  it('the expired-session banner’s Sign in again, which says nothing can upload', () => {
    const shell = plannerSource()
    expect(shell).toMatch(/const signIn = useSignOut\(async \(\) => \{\s*await getSupabase\(\)\?\.auth\.signOut\(\)\s*await clearLocalData\(\)\s*window\.location\.reload\(\)\s*\}, store\.syncInfo\.authError\)/)
    expect(shell).toContain('onClick={signIn.start}')
    expect(shell).toContain('{signIn.question}')
  })

  it('the assistant consent sheet’s Sign out, held until the sign-out itself is done', () => {
    const src = read('../components/ConnectAssistantSheet.tsx')
    expect(src).toContain('onSignOut(): Promise<void>')
    expect(src).toContain('const signOut = useSignOut(onSignOut)')
    expect(src).toContain('onClick={signOut.start}')
    expect(src).toContain('{signOut.question}')
    // App hands over the sign-out's own promise, not one it has dropped
    expect(read('../App.tsx')).toContain('onSignOut={signOutForAnotherAccount}')
  })

  it('leaves no button that wipes this device without asking', () => {
    for (const src of [read('../components/settings/Household.tsx'), plannerSource(), read('../components/ConnectAssistantSheet.tsx')]) {
      expect(src).not.toMatch(/onClick=\{async \(\) => \{[^}]*clearLocalData/)
      expect(src).not.toMatch(/onClick=\{onSignOut\}/)
    }
  })
})

/*
 * What a sign-out leaves behind.
 *
 * clearLocalData removes every drafter:* key, which is the point: the planner
 * must not stay readable on a shared, sold or stolen device. Two keys are
 * exempt because they describe the SCREEN and not the person — the colour it
 * is painted in and which of Home's headings are folded shut — and the owner
 * asked for the folds to survive a login ("leave it that way each time the
 * user logs in till they change it").
 *
 * The exemption is the dangerous part, so it is pinned: a key that names a
 * record, a person, a place, a date, a count or a habit of use is the
 * person's, and belongs in the wipe.
 */
describe('what survives a sign-out', () => {
  const idb = readFileSync(fileURLToPath(new URL('../idb.ts', import.meta.url)), 'utf8')
  const kept = [...(idb.match(/const KEPT_ACROSS_SIGN_OUT = new Set\(\[([^\]]*)\]\)/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1])

  it('keeps the two display settings, and nothing else', () => {
    expect(kept.sort()).toEqual(['drafter:home-folded', 'drafter:theme'])
  })

  it('reads the list when it decides what to remove', () => {
    expect(idb).toMatch(/k\.startsWith\('drafter:'\) && !KEPT_ACROSS_SIGN_OUT\.has\(k\)/)
  })

  it('exempts nothing that could name what the person keeps', () => {
    // the keys that hold records, cursors, counts or where they last were
    for (const key of [
      'drafter:household',
      'drafter:chat-seen',
      'drafter:dirty-ids',
      'drafter:sync-cursor',
      'drafter:kitchen-recipes',
      'drafter:keep-tab',
      'drafter:tasks-tab',
      'drafter:insights-tab',
      'drafter:calendar-mode',
      'drafter:app-lock',
      'drafter:weather',
    ])
      expect(kept, key).not.toContain(key)
  })

  it('exempts only keys whose value cannot say anything about an account', () => {
    // a fold is a list of section NAMES; a theme is a colour. Neither can
    // carry a title, a date or a count, whatever the account holds.
    const folds = readFileSync(fileURLToPath(new URL('../homefolds.ts', import.meta.url)), 'utf8')
    expect(folds).toMatch(/const KEY = 'drafter:home-folded'/)
    expect(folds).toMatch(/filter\(\(id\): id is string => typeof id === 'string'\)/)
  })
})
