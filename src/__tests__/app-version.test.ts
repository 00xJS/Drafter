import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bumpVersion, formatVersion, parseVersion } from '../../scripts/app-version.mjs'
import { APP_VERSION } from '../appversion'

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

describe('app version: 1.0.1 for a small drop', () => {
  it('treats 1.0 and 1.0.0 as the same, and stores three parts', () => {
    expect(parseVersion('1.0')).toEqual([1, 0, 0])
    expect(parseVersion('1.0.1')).toEqual([1, 0, 1])
    expect(formatVersion([1, 0, 0])).toBe('1.0.0')
    expect(parseVersion('nope')).toBeNull()
  })

  it('raises patch, minor and major the way the names say', () => {
    expect(bumpVersion('1.0', 'patch')).toBe('1.0.1')
    expect(bumpVersion('1.0.1', 'patch')).toBe('1.0.2')
    expect(bumpVersion('1.0.9', 'minor')).toBe('1.1.0')
    expect(bumpVersion('1.1.4', 'major')).toBe('2.0.0')
  })

  it('keeps package.json, Xcode and Settings on the same number', () => {
    const pkg = JSON.parse(read('../../package.json')) as { version: string }
    const pbx = read('../../ios/App/App.xcodeproj/project.pbxproj')
    const names = [...pbx.matchAll(/MARKETING_VERSION = ([\d.]+);/g)].map(m => m[1])
    expect(pkg.version).toBe(APP_VERSION)
    expect(names.length).toBeGreaterThan(1)
    expect(new Set(names)).toEqual(new Set([APP_VERSION]))
  })
})
