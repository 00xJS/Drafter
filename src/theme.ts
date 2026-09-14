import { useSyncExternalStore } from 'react'

/*
 * Settings → Appearance: Light (the default), Dark, or Match system, kept on
 * each device. The stylesheet holds one palette per theme (src/styles/01-base.css:
 * light on :root, dark on :root[data-theme='dark']), so a theme is one attribute
 * on <html>. index.html's inline script stamps it before the first paint, from
 * the key, default and grounds kept here (theme.test.ts runs that script to hold
 * the two in step); startTheme keeps it true for the rest of the visit.
 */

export type ThemePref = 'light' | 'dark' | 'system'
export type Theme = 'light' | 'dark'

/** Per device, like drafter:app-lock. index.html's inline script reads the same key. */
export const THEME_KEY = 'drafter:theme'
export const THEME_PREFS: readonly ThemePref[] = ['light', 'dark', 'system']
export const THEME_LABELS: Record<ThemePref, string> = { light: 'Light', dark: 'Dark', system: 'Match system' }

/** What is painted before the page: meta theme-color, the manifest, Capacitor's
    web view, the launch screen, the privacy cover and the lock overlay. */
export const THEME_GROUND: Record<Theme, string> = { light: '#f6f7f9', dark: '#0f1115' }

/** The token values the contrast helpers compute against, mirrored from 01-base.css (theme-tokens.test.ts pins them). */
export const THEME_HEX: Record<Theme, { surface: string; inkGround: string; text: string }> = {
  // inkGround = --surface-2, the darkest ground a pill sits on
  light: { surface: '#ffffff', inkGround: '#eef0f3', text: '#15181f' },
  // inkGround = --surface, which keeps every palette colour exactly as it was
  dark: { surface: '#15181f', inkGround: '#15181f', text: '#edeff3' },
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** A stored value as a preference: 'dark' and 'system' pass, and anything else is the default. */
export function parseThemePref(raw: unknown): ThemePref {
  return raw === 'dark' || raw === 'system' ? raw : 'light'
}

/** The theme a preference paints while the device is (or is not) dark. */
export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  return pref === 'dark' || (pref === 'system' && systemDark) ? 'dark' : 'light'
}

/** This device's choice: light when nothing is stored, or storage cannot be read. */
export function readThemePref(): ThemePref {
  try {
    return parseThemePref(localStorage.getItem(THEME_KEY))
  } catch {
    return 'light'
  }
}

function writeThemePref(pref: ThemePref): void {
  try {
    // explicit, 'light' included: the stored value is what the inline script reads
    localStorage.setItem(THEME_KEY, pref)
  } catch {
    /* private mode or blocked storage: the choice still holds for this visit */
  }
}

/** Whether the device is dark right now (in the iOS shell, the window's style). */
export function systemPrefersDark(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches
  } catch {
    return false
  }
}

/**
 * Paint `theme`: the attribute the stylesheet keys off, the inline color-scheme
 * (native controls, scrollbars, pickers, autofill) and the browser's
 * theme-color. All three every time: the inline color-scheme outranks the
 * sheet, so they must never disagree. Idempotent.
 */
export function applyTheme(theme: Theme, doc: Document | undefined = typeof document === 'undefined' ? undefined : document): void {
  if (!doc) return
  const root = doc.documentElement
  root.setAttribute('data-theme', theme)
  root.style.colorScheme = theme
  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_GROUND[theme])
}

/** The theme on the page now. */
export function currentTheme(): Theme {
  return typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

// The choice in force for this visit: the last one read or made. One that
// storage refused to keep still holds until the page reloads.
let activePref: ThemePref = 'light'
const listeners = new Set<() => void>()

/** Resolve and paint a choice, then tell everyone listening. */
function commit(pref: ThemePref): void {
  activePref = pref
  applyTheme(resolveTheme(pref, systemPrefersDark()))
  for (const cb of [...listeners]) cb()
}

/** Settings → Appearance: keep the choice on this device and repaint at once. */
export function setThemePref(pref: ThemePref): void {
  writeThemePref(pref)
  commit(pref)
}

/** Hear every repaint: a choice, the device turning dark, a choice made in another tab. Returns a disposer. */
export function subscribeTheme(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** The theme on the page, re-rendering as it changes. Light in a server render. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, currentTheme, (): Theme => 'light')
}

/**
 * Paint the stored choice and keep it true for the visit: Match system follows
 * the device as it changes, and a choice made in another tab lands here too.
 * `onChange` hears the choice and the theme now, and again after every repaint;
 * main.tsx passes them to the iOS shell for what the page cannot paint itself.
 * Returns a disposer.
 */
export function startTheme(onChange?: (pref: ThemePref, theme: Theme) => void): () => void {
  commit(readThemePref())
  const report = () => onChange?.(activePref, currentTheme())
  report()
  const stopReporting = subscribeTheme(report)
  if (typeof window === 'undefined') return stopReporting
  // Listened to whatever the choice is now, so switching to Match system later
  // needs nothing more. In the iOS shell, Dark → Match system first resolves
  // against the web view's still-dark window; the change that follows once the
  // shell lets go of that override is what corrects it.
  let media: MediaQueryList | null = null
  try {
    media = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null
  } catch {
    media = null
  }
  const onSystem = () => {
    if (activePref === 'system') commit(activePref)
  }
  const onStorage = (e: StorageEvent) => {
    // a null key is another tab clearing storage altogether
    if (e.key === THEME_KEY || e.key === null) commit(readThemePref())
  }
  media?.addEventListener('change', onSystem)
  window.addEventListener('storage', onStorage)
  return () => {
    stopReporting()
    media?.removeEventListener('change', onSystem)
    window.removeEventListener('storage', onStorage)
  }
}
