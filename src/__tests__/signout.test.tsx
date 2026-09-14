import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { plannerSource } from './source'

// Signing out wipes this device (clearLocalData deletes the whole IndexedDB),
// so a photo that had not finished uploading — a piece of clothing's, a note's
// or a task's — was lost without a word. Every sign-out the person starts now
// asks first while one is waiting: "n photos haven't uploaded yet", with Try
// uploading now, Sign out anyway and Cancel. The media store is a stand-in.

const media = vi.hoisted(() => ({ count: 0 as number | Error, flushes: 0 }))
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

import { UnsentPhotosSheet, useSignOut } from '../components/SignOutGuard'
import { startSignOut, unsentLine, uploadThenSignOut, withMedia, type SignOutSteps } from '../signout'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const noop = () => {}

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
})

describe('withMedia: the media store around a sign-out', () => {
  it('asks the store how many are waiting, and flushes it', async () => {
    media.count = 4
    const signOut = vi.fn(async () => {})
    expect(await startSignOut(withMedia(signOut))).toEqual({ count: 4, tried: false })
    media.count = 0
    const before = media.flushes
    expect(await uploadThenSignOut(withMedia(signOut))).toBeNull()
    expect(media.flushes).toBe(before + 1)
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
    const answers = [...html.matchAll(/<button type="button" class="([^"]+)"[^>]*>([^<]+)<\/button>/g)].map(m => [m[1], m[2]])
    expect(answers).toEqual([
      ['btn danger', 'Sign out anyway'],
      ['btn', 'Cancel'],
      ['btn primary', 'Try uploading now'],
    ])
    expect(html).not.toContain('disabled')
    expect(html).not.toContain('role="alert"')
  })

  it('says so when the upload just tried did not get them all up', () => {
    expect(renderToStaticMarkup(<UnsentPhotosSheet count={2} tried busy={null} onUpload={noop} onSignOut={noop} onCancel={noop} />)).toContain(
      '<p class="warn" role="alert">They couldn’t be uploaded just now. Check the connection, then try again.</p>',
    )
    expect(renderToStaticMarkup(<UnsentPhotosSheet count={1} tried busy={null} onUpload={noop} onSignOut={noop} onCancel={noop} />)).toContain('It couldn’t be uploaded just now.')
  })

  it('holds every answer while an upload or the sign-out is under way, and says which', () => {
    const uploading = renderToStaticMarkup(<UnsentPhotosSheet count={2} tried={false} busy="uploading" onUpload={noop} onSignOut={noop} onCancel={noop} />)
    expect(uploading.match(/disabled=""/g)).toHaveLength(3)
    expect(uploading).toContain('Uploading…')
    const leaving = renderToStaticMarkup(<UnsentPhotosSheet count={2} tried={false} busy="signing-out" onUpload={noop} onSignOut={noop} onCancel={noop} />)
    expect(leaving).toContain('Signing out…')
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
  it('Settings → Account: the whole sign-out runs only through the question', () => {
    const src = read('../components/settings/Household.tsx')
    expect(src).toMatch(/const signOut = useSignOut\(async \(\) => \{\s*await disablePush\(\)[\s\S]*?await getSupabase\(\)\?\.auth\.signOut\(\)\s*await clearLocalData\(\)/)
    expect(src).toContain('onClick={signOut.start}')
    expect(src).toContain('{signOut.question}')
  })

  it('the expired-session banner’s Sign in again', () => {
    const shell = plannerSource()
    expect(shell).toMatch(/const signIn = useSignOut\(async \(\) => \{\s*await getSupabase\(\)\?\.auth\.signOut\(\)\s*await clearLocalData\(\)/)
    expect(shell).toContain('onClick={signIn.start}')
    expect(shell).toContain('{signIn.question}')
  })

  it('the assistant consent sheet’s Sign out', () => {
    const src = read('../components/ConnectAssistantSheet.tsx')
    expect(src).toContain('const signOut = useSignOut(async () => onSignOut())')
    expect(src).toContain('onClick={signOut.start}')
    expect(src).toContain('{signOut.question}')
  })

  it('leaves no button that wipes this device without asking', () => {
    for (const src of [read('../components/settings/Household.tsx'), plannerSource(), read('../components/ConnectAssistantSheet.tsx')]) {
      expect(src).not.toMatch(/onClick=\{async \(\) => \{[^}]*clearLocalData/)
      expect(src).not.toMatch(/onClick=\{onSignOut\}/)
    }
  })
})
