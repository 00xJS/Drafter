import { Post } from './types'
import { STORAGE_VERSION } from './schema'
import { idbDel, idbGet, idbSet } from './idb'

// File System Access API (Chromium). The chosen file handle persists in
// IndexedDB; after a reload the browser may require a click to re-grant access.

interface PermHandle extends FileSystemFileHandle {
  queryPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
}

declare global {
  interface Window {
    showSaveFilePicker?(options?: {
      suggestedName?: string
      types?: { description?: string; accept: Record<string, string[]> }[]
    }): Promise<FileSystemFileHandle>
  }
}

export type BackupStatus = 'unsupported' | 'none' | 'needs-permission' | 'active'

let handle: PermHandle | null = null
let timer: number | undefined

export async function initBackup(): Promise<BackupStatus> {
  if (!window.showSaveFilePicker) return 'unsupported'
  try {
    handle = (await idbGet<PermHandle>('handles', 'backup')) ?? null
  } catch {
    handle = null
  }
  if (!handle) return 'none'
  const perm = (await handle.queryPermission?.({ mode: 'readwrite' })) ?? 'prompt'
  return perm === 'granted' ? 'active' : 'needs-permission'
}

export async function chooseBackupFile(): Promise<BackupStatus> {
  if (!window.showSaveFilePicker) return 'unsupported'
  const h = await window.showSaveFilePicker({
    suggestedName: 'drafter-backup.json',
    types: [{ description: 'JSON backup', accept: { 'application/json': ['.json'] } }],
  })
  handle = h as PermHandle
  await idbSet('handles', 'backup', h)
  return 'active'
}

export async function resumeBackup(): Promise<BackupStatus> {
  if (!handle) return 'none'
  const perm = (await handle.requestPermission?.({ mode: 'readwrite' })) ?? 'denied'
  return perm === 'granted' ? 'active' : 'needs-permission'
}

export async function disableBackup(): Promise<BackupStatus> {
  handle = null
  await idbDel('handles', 'backup')
  return 'none'
}

/** Debounced write of the full data set to the chosen backup file. */
export function scheduleBackup(posts: Post[]): void {
  if (!handle) return
  window.clearTimeout(timer)
  timer = window.setTimeout(async () => {
    try {
      const h = handle
      if (!h) return
      if (((await h.queryPermission?.({ mode: 'readwrite' })) ?? 'prompt') !== 'granted') return
      const writable = await h.createWritable()
      await writable.write(
        JSON.stringify({ version: STORAGE_VERSION, exportedAt: new Date().toISOString(), posts }, null, 2),
      )
      await writable.close()
    } catch (e) {
      console.error('Backup write failed', e)
    }
  }, 1500)
}
