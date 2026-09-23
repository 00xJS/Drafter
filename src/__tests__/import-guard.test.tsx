import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ImportNotice, importFile, importRefusal } from '../components/settings/ImportExport'

// Restoring from a nightly snapshot is Admin → Backups → Save the readable
// copy, then Settings → Data → Import a file. A snapshot names the account it
// was taken of, but Import never read it: it merges by id and files every
// record under whoever imports, so the other member's snapshot would have come
// back as the importer's own records, journal and all. It is refused now, and
// nothing of it is imported. And a failed import no longer reads in the
// success green.

const OWNER = '907ec8ad-a40a-47c1-8a0f-16ff7243ba87'
const MEMBER = '5b0c2f1e-7d44-4c1b-9a53-2f4e8c1d6a70'
const T = '2026-09-20T09:00:00.000Z'
const task = (id: string) => ({ kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', createdAt: T, updatedAt: T, tags: [] })
const snapshot = (userId: string) => ({ exportedAt: T, userId, items: [task('t1'), task('t2')] })
const file = (v: unknown) => new Blob([typeof v === 'string' ? v : JSON.stringify(v)], { type: 'application/json' })
const merged = () => vi.fn((_items: unknown[]) => ({ added: 2, updated: 0, unchanged: 0, metricsRefreshed: 0 }))

describe('importing a nightly snapshot', () => {
  it('refuses the other member’s, and imports nothing of it', async () => {
    const importItems = merged()
    const notice = await importFile(file(snapshot(MEMBER)), { myId: OWNER, signedIn: true, importItems })
    expect(notice.ok).toBe(false)
    expect(notice.text).toContain('this backup is of another account')
    expect(notice.text).toContain('Import it while signed in as that account')
    expect(importItems).not.toHaveBeenCalled()
  })

  it('takes back the signed-in account’s own', async () => {
    const importItems = merged()
    const notice = await importFile(file(snapshot(OWNER)), { myId: OWNER, signedIn: true, importItems })
    expect(notice).toEqual({ text: 'Imported: 2 new, 0 updated, 0 unchanged.', ok: true })
    expect(importItems.mock.calls[0][0].map(i => (i as { id: string }).id)).toEqual(['t1', 't2'])
  })

  it('refuses while it cannot yet tell who is signed in, rather than guess', async () => {
    const importItems = merged()
    const notice = await importFile(file(snapshot(OWNER)), { myId: null, signedIn: true, importItems })
    expect(notice.ok).toBe(false)
    expect(notice.text).toContain('could not tell which account is signed in')
    expect(importItems).not.toHaveBeenCalled()
  })

  it('takes a file that names no account, as before: an export from Settings, or a bare list', async () => {
    for (const payload of [{ version: 3, exportedAt: T, items: [task('t1')] }, [task('t1')]]) {
      const importItems = merged()
      await expect(importFile(file(payload), { myId: OWNER, signedIn: true, importItems })).resolves.toMatchObject({ ok: true })
      expect(importItems).toHaveBeenCalledTimes(1)
    }
  })

  it('takes anything in local mode, where there is no account to file it under', () => {
    expect(importRefusal(snapshot(MEMBER), null, false)).toBeNull()
    expect(importRefusal(snapshot(MEMBER), OWNER, true)).not.toBeNull()
    expect(importRefusal({ userId: 42, items: [] }, OWNER, true)).toBeNull()
  })

  it('says a file that is not a backup, or not JSON at all, failed — as a failure', async () => {
    const importItems = merged()
    const notBackup = await importFile(file({ hello: 'world' }), { myId: OWNER, signedIn: true, importItems })
    expect(notBackup).toEqual({ text: 'Import failed: expected a Drafter backup (array, {version, posts} or {version, items})', ok: false })
    const broken = await importFile(file('{"items": ['), { myId: OWNER, signedIn: true, importItems })
    expect(broken.ok).toBe(false)
    expect(broken.text).toMatch(/^Import failed: /)
    expect(importItems).not.toHaveBeenCalled()
  })
})

describe('what an import says', () => {
  it('draws a success in green and a failure as a warning, never the other way round', () => {
    expect(renderToStaticMarkup(<ImportNotice notice={{ text: 'Imported: 2 new, 0 updated, 0 unchanged.', ok: true }} />)).toBe(
      '<p class="sync-ok">Imported: 2 new, 0 updated, 0 unchanged.</p>',
    )
    expect(renderToStaticMarkup(<ImportNotice notice={{ text: 'Import failed: Unexpected end of JSON input', ok: false }} />)).toBe(
      '<p class="warn" role="alert">Import failed: Unexpected end of JSON input</p>',
    )
  })
})
