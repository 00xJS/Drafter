import { createElement, lazy, useState, type ComponentType, type ReactElement } from 'react'

/*
 * Loading views and editors on demand without making them slow to open.
 *
 * Plain React.lazy has a cost even once a chunk is cached: every first render
 * of a lazy component suspends for at least a microtask, and once a Suspense
 * fallback has shown, react-dom 18 holds the content back for up to 500 ms
 * (FALLBACK_THROTTLE_MS). So the chunks are fetched ahead of time, and a
 * component whose chunk is already here is rendered directly.
 */

/** A component whose chunk can be fetched ahead of time. */
export interface PreloadableComponent<P> {
  (props: P): ReactElement
  /** Fetch the chunk now. A failure is not remembered, so the next open fetches it again. */
  preload(): Promise<void>
  displayName?: string
}

/**
 * React.lazy, minus its cost once the chunk is here. The import is fetched
 * once and remembered. An instance that mounts after the chunk arrived renders
 * the loaded component itself, so nothing suspends; only an instance that
 * mounts while the chunk is still on its way goes through React.lazy.
 */
export function preloadable<P extends object>(factory: () => Promise<ComponentType<P>>, name = 'Preloadable'): PreloadableComponent<P> {
  let loaded: ComponentType<P> | null = null
  let pending: Promise<ComponentType<P>> | null = null
  const makeLazy = () => lazy(() => load().then(component => ({ default: component })))
  const load = (): Promise<ComponentType<P>> =>
    (pending ??= factory().then(
      component => (loaded = component),
      err => {
        // not remembered: the next open fetches again, through a fresh lazy wrapper
        pending = null
        viaLazy = makeLazy()
        throw err
      },
    ))
  let viaLazy = makeLazy()

  const Preloadable = (props: P) => {
    // decided once per mount: switching an instance from the lazy wrapper to
    // the loaded component would remount it and drop its state
    const [direct] = useState<ComponentType<P> | null>(() => loaded)
    return createElement((direct ?? viaLazy) as ComponentType<P>, props)
  }
  Preloadable.displayName = name
  Preloadable.preload = () => load().then(() => undefined)
  return Preloadable
}

/** Warm-ups in flight. A chunk that fails while one runs is not worth a reload: the view fetches it again when it opens. */
let warming = 0

function quietly(preload: () => Promise<unknown>): Promise<unknown> {
  warming++
  return preload()
    .catch(() => {
      /* fetched again when the view opens; a failure there is the one that counts */
    })
    .finally(() => {
      warming--
    })
}

/** Start fetching these chunks now (a finger landing on a tab, a button taking focus). */
export function warm(...preloads: (() => Promise<unknown>)[]): void {
  for (const preload of preloads) void quietly(preload)
}

/**
 * Fetch these chunks one after another, starting a moment after launch so the
 * first paint has the network to itself. A timer, because WKWebView has no
 * requestIdleCallback. Returns a cancel, for the effect that starts it.
 */
export function schedulePreload(preloads: readonly (() => Promise<unknown>)[], delayMs = 1500): () => void {
  let cancelled = false
  const timer = setTimeout(() => {
    void preloads.reduce<Promise<unknown>>((prev, preload) => prev.then(() => (cancelled ? undefined : quietly(preload))), Promise.resolve())
  }, delayMs)
  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}

/** sessionStorage key holding when a failed chunk last reloaded the page. */
export const CHUNK_RELOAD_KEY = 'drafter:chunk-reload'
/** A second failure this soon after a reload is not reloaded again: whatever it is, a reload does not fix it. */
export const CHUNK_RELOAD_WINDOW_MS = 60_000

/**
 * Whether a chunk that failed to load should reload the page, noting the
 * reload if so. A deploy replaces every hashed chunk, so a page loaded before
 * it asks for files that are gone, and one reload fetches the new index and its
 * chunks. A second failure inside the window (offline, a broken deploy) is left
 * to the error boundary, so a missing file can never loop the page.
 */
export function shouldReloadForChunk(storage: Pick<Storage, 'getItem' | 'setItem'> | null, now = Date.now()): boolean {
  if (!storage) return false
  try {
    const last = Number(storage.getItem(CHUNK_RELOAD_KEY)) || 0
    if (last && now - last < CHUNK_RELOAD_WINDOW_MS) return false
    storage.setItem(CHUNK_RELOAD_KEY, String(now))
    return true
  } catch {
    // a reload that cannot be noted down could repeat forever
    return false
  }
}

/**
 * Install once, from App.tsx: when Vite reports a chunk that would not load
 * (vite:preloadError), reload the page — at most once a minute, never for a
 * background warm-up, and never offline, where a reload fetches nothing new.
 */
export function guardChunkLoads(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('vite:preloadError', () => {
    if (warming > 0 || navigator.onLine === false) return
    let storage: Storage | null = null
    try {
      storage = window.sessionStorage
    } catch {
      storage = null
    }
    if (shouldReloadForChunk(storage)) window.location.reload()
  })
}
