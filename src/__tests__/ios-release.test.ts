import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { changedPaths, onlyNumbersChanged } from '../../scripts/ios-release.mjs'

// npm run release:ios builds the phone's bundle from the working tree, so it
// refuses while anything is changed but the version numbers it writes itself,
// and runs the unit tests before it raises one.

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PBX = 'ios/App/App.xcodeproj/project.pbxproj'

const pkg = (version: string, dependencies: Record<string, string> = { react: '^19.3.0' }) => `${JSON.stringify({ name: 'drafter', version, dependencies }, null, 2)}\n`
const lock = (version: string, react = '19.3.0') =>
  `${JSON.stringify({ name: 'drafter', version, packages: { '': { name: 'drafter', version }, 'node_modules/react': { version: react } } }, null, 2)}\n`
const pbx = (marketing: string, build: number, swift = '5.0') =>
  `MARKETING_VERSION = ${marketing};\nCURRENT_PROJECT_VERSION = ${build};\nSWIFT_VERSION = ${swift};\nMARKETING_VERSION = ${marketing};\n`

describe('what git says is changed', () => {
  it('reads every entry of the NUL-separated status, a rename by both its names', () => {
    const status = [' M src/store.ts', '?? src/new file.ts', 'A  package.json', 'R  src/b.ts', 'src/a.ts', 'MM ios/App/App.xcodeproj/project.pbxproj', ''].join('\0')
    expect(changedPaths(status)).toEqual(['src/store.ts', 'src/new file.ts', 'package.json', 'src/b.ts', 'src/a.ts', PBX])
    expect(changedPaths('')).toEqual([])
  })
})

describe('the only change a release builds over', () => {
  it('is the numbers an earlier run raised: the version, the lockfile root, Xcode and APP_VERSION', () => {
    expect(onlyNumbersChanged('package.json', pkg('1.1.2'), pkg('1.1.3'))).toBe(true)
    expect(onlyNumbersChanged('package-lock.json', lock('1.1.2'), lock('1.1.3'))).toBe(true)
    expect(onlyNumbersChanged(PBX, pbx('1.1.2', 15), pbx('1.1.3', 16))).toBe(true)
    expect(onlyNumbersChanged('src/appversion.ts', "export const APP_VERSION = '1.1.2'\n", "export const APP_VERSION = '1.1.3'\n")).toBe(true)
  })

  it('and never anything else in those files: a dependency, a lockfile entry, a build setting', () => {
    expect(onlyNumbersChanged('package.json', pkg('1.1.2'), pkg('1.1.3', { react: '^19.4.0' }))).toBe(false)
    expect(onlyNumbersChanged('package-lock.json', lock('1.1.2'), lock('1.1.2', '19.4.0'))).toBe(false)
    expect(onlyNumbersChanged(PBX, pbx('1.1.2', 15), pbx('1.1.2', 15, '6.0'))).toBe(false)
    expect(onlyNumbersChanged('src/appversion.ts', "export const APP_VERSION = '1.1.2'\n", "export const APP_VERSION = '1.1.2'\nexport const BETA = true\n")).toBe(false)
  })

  it('nor a file that is not a version file, a new one, or one that no longer parses', () => {
    expect(onlyNumbersChanged('src/store.ts', 'a', 'a')).toBe(false)
    expect(onlyNumbersChanged('package.json', null, pkg('1.1.3'))).toBe(false)
    expect(onlyNumbersChanged('package.json', pkg('1.1.2'), '{ "name": ')).toBe(false)
  })
})

describe('npm run release:ios in a tree with changes nobody committed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drafter-release-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  // git needs its PATH; nothing else of this machine's environment is handed on
  const env = { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_NOSYSTEM: '1' }
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: dir, env, stdio: 'pipe' })

  it('refuses before it raises a number or runs anything, and names what is changed', () => {
    for (const file of ['scripts/ios-release.mjs', 'scripts/app-version.mjs', 'scripts/lib/pbxproj.mjs', 'shared/appversion.mts', 'package.json', 'package-lock.json', 'src/appversion.ts', PBX]) {
      cpSync(join(ROOT, file), join(dir, file))
    }
    git('init', '-q')
    git('add', '-A')
    git('commit', '-q', '-m', 'as released')
    // a raised number from a run that stopped part-way is allowed; the rest is not
    execFileSync(process.execPath, ['scripts/app-version.mjs', '--patch'], { cwd: dir, env: {}, stdio: 'pipe' })
    const raised = readFileSync(join(dir, 'package.json'), 'utf8')
    writeFileSync(join(dir, 'src/uncommitted.ts'), 'export const x = 1\n')
    writeFileSync(join(dir, 'shared/appversion.mts'), `${readFileSync(join(dir, 'shared/appversion.mts'), 'utf8')}// edited\n`)

    const run = spawnSync(process.execPath, ['scripts/ios-release.mjs'], { cwd: dir, env, encoding: 'utf8' })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('src/uncommitted.ts')
    expect(run.stderr).toContain('shared/appversion.mts')
    for (const file of ['package.json', 'package-lock.json', PBX, 'src/appversion.ts']) expect(run.stderr).not.toContain(`  ${file}\n`)
    expect(run.stderr).toContain('Nothing was raised or built.')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(raised)
  })
})
