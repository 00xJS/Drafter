import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { bumpVersion, formatVersion, parseVersion } from '../../shared/appversion.mjs'
import { nativeTargets, parsePbxproj, versionDrift } from '../../scripts/lib/pbxproj.mjs'
import { APP_VERSION } from '../appversion'

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PBX = 'ios/App/App.xcodeproj/project.pbxproj'

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

/*
 * The widget is an extension embedded in the app, and App Store Connect
 * refuses an upload whose extension carries a version or build number of its
 * own — after the archive, the export and the upload have run. So both
 * numbers are raised on both targets, by the scripts that raise them, and
 * ios-release.mjs checks they agree before it builds.
 */
describe('the widget ships with the app’s numbers', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'drafter-version-'))
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  /** A copy of what a script reads and writes, so the real files are never touched. */
  const copyOf = (name: string, files: string[]) => {
    const dir = join(scratch, name)
    for (const file of files) cpSync(join(ROOT, file), join(dir, file))
    return dir
  }
  const run = (dir: string, script: string, args: string[]) => execFileSync(process.execPath, [script, ...args], { cwd: dir, env: {}, encoding: 'utf8' })
  const settings = (dir: string) =>
    nativeTargets(parsePbxproj(readFileSync(join(dir, PBX), 'utf8'))).flatMap(t => Object.entries(t.configurations).map(([config, s]) => ({ where: `${t.name} ${config}`, marketing: s.MARKETING_VERSION, build: s.CURRENT_PROJECT_VERSION })))

  it('is in step as committed: the app and the widget, Debug and Release', () => {
    const project = parsePbxproj(read(`../../${PBX}`))
    expect(nativeTargets(project).map(t => t.name).sort()).toEqual(['App', 'DrafterWidgets'])
    expect(versionDrift(project)).toEqual([])
    const rows = settings(ROOT)
    expect(rows.map(r => r.where).sort()).toEqual(['App Debug', 'App Release', 'DrafterWidgets Debug', 'DrafterWidgets Release'])
    for (const row of rows) expect(row.marketing, row.where).toBe(APP_VERSION)
  })

  it('app-version.mjs raises the version people read on both targets', () => {
    const dir = copyOf('marketing', ['scripts/app-version.mjs', 'scripts/lib/pbxproj.mjs', 'shared/appversion.mjs', 'package.json', 'package-lock.json', 'src/appversion.ts', PBX])
    const out = run(dir, 'scripts/app-version.mjs', ['--set', '9.8.7'])
    expect(out).toContain('-> 9.8.7 (App and DrafterWidgets, 4 Xcode configurations)')
    const rows = settings(dir)
    expect(rows).toHaveLength(4)
    for (const row of rows) expect(row.marketing, row.where).toBe('9.8.7')
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version).toBe('9.8.7')
    expect(readFileSync(join(dir, 'src/appversion.ts'), 'utf8')).toContain("APP_VERSION = '9.8.7'")
    // and a patch from there moves them all again
    run(dir, 'scripts/app-version.mjs', ['--patch'])
    expect(new Set(settings(dir).map(r => r.marketing))).toEqual(new Set(['9.8.8']))
  })

  it('ios-build-number.mjs raises the build number on both targets, locally and as Xcode Cloud calls it', () => {
    const dir = copyOf('build', ['scripts/ios-build-number.mjs', PBX])
    // ci_pre_xcodebuild.sh: the cloud's own counter
    run(dir, 'scripts/ios-build-number.mjs', ['--set', '77'])
    expect(new Set(settings(dir).map(r => r.build))).toEqual(new Set(['77']))
    // npm run release:ios: one more than the highest
    run(dir, 'scripts/ios-build-number.mjs', [])
    const rows = settings(dir)
    expect(rows).toHaveLength(4)
    for (const row of rows) expect(row.build, row.where).toBe('78')
    expect(versionDrift(parsePbxproj(readFileSync(join(dir, PBX), 'utf8')))).toEqual([])
  })

  it('names a widget left behind, which ios-release.mjs refuses to build', () => {
    const project = parsePbxproj(read(`../../${PBX}`))
    const widget = nativeTargets(project).find(t => t.name === 'DrafterWidgets')!
    widget.configurations.Release.CURRENT_PROJECT_VERSION = '12'
    widget.configurations.Debug.MARKETING_VERSION = '1.0.9'
    expect(versionDrift(project)).toEqual([
      expect.stringMatching(/^DrafterWidgets Debug has MARKETING_VERSION 1\.0\.9, App (Debug|Release) has /),
      expect.stringMatching(/^DrafterWidgets Release has CURRENT_PROJECT_VERSION 12, App (Debug|Release) has /),
    ])
    const release = read('../../scripts/ios-release.mjs')
    // checked after both numbers are raised, and before anything is built
    expect(release.indexOf('versionProblems(')).toBeGreaterThan(release.indexOf("'scripts/ios-build-number.mjs'"))
    expect(release.indexOf('versionProblems(')).toBeLessThan(release.indexOf("'build:ios'"))
  })
})
