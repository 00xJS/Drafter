import { describe, expect, it, vi } from 'vitest'

// syncNativeAppearance hands Settings → Appearance to the iOS shell
// (AppearancePlugin in ios/App/App/SceneDelegate.swift) and sets the keyboard.
// In a browser it must do nothing at all: there is no shell to answer, and a
// plugin registered there would only fail on every repaint.
// launchscreen.test.ts holds the plugin's name, method and key to the Swift side.

const env = vi.hoisted(() => ({
  native: false,
  registered: [] as string[],
  applied: [] as unknown[],
  keyboard: [] as unknown[],
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => env.native, getPlatform: () => (env.native ? 'ios' : 'web') },
  registerPlugin: (name: string) => {
    env.registered.push(name)
    return {
      apply: async (options: unknown) => {
        env.applied.push(options)
      },
    }
  },
}))
vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    setStyle: async (options: unknown) => {
      env.keyboard.push(options)
    },
  },
  KeyboardStyle: { Dark: 'DARK', Light: 'LIGHT' },
}))

import { syncNativeAppearance } from '../native'

describe('syncNativeAppearance', () => {
  it('does nothing in a browser: no plugin registered, no keyboard touched', async () => {
    env.native = false
    await syncNativeAppearance('dark', 'dark')
    await syncNativeAppearance('system', 'light')
    expect(env).toMatchObject({ registered: [], applied: [], keyboard: [] })
  })

  it('in the shell, passes the choice itself (Match system included) and sets the keyboard from the theme it resolved to', async () => {
    env.native = true
    await syncNativeAppearance('system', 'dark')
    await syncNativeAppearance('light', 'light')
    await syncNativeAppearance('dark', 'dark')
    expect(env.applied).toEqual([{ style: 'system' }, { style: 'light' }, { style: 'dark' }])
    expect(env.keyboard).toEqual([{ style: 'DARK' }, { style: 'LIGHT' }, { style: 'DARK' }])
    // registered once: Capacitor refuses a second registration under the same name
    expect(env.registered).toEqual(['Appearance'])
  })
})
