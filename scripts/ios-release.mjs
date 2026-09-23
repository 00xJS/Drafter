#!/usr/bin/env node
// Put a new build on a phone: raise the version people read (unless asked
// not to), raise Apple's build number, rebuild the bundle, open Xcode.
//
//   npm run release:ios              1.0.1 and build N+1  (a small drop)
//   npm run release:ios -- --minor   1.1.0
//   npm run release:ios -- --major   2.0.0
//   npm run release:ios -- --keep    same 1.0.1, new build number only
//
// Both numbers go on every target: the app, and the widget extension embedded
// in it (DrafterWidgets). App Store Connect refuses an upload whose extension
// carries a version or build number of its own — after the archive, the export
// and the upload have run — so the two are checked here, before any of that.
//
// What goes on the phone is what is committed. The bundle is built from the
// working tree, so a change nobody had committed went onto the phone and into
// no commit anyone could find. The run refuses while anything is changed but
// the version numbers it writes itself (an earlier run that stopped part-way
// leaves those), and runs the unit tests before it raises a number. In an
// emergency, `-- --skip-tests` builds without the tests, and says so.
//
// Xcode Cloud never runs this. It sets the build number from CI_BUILD_NUMBER
// and keeps the committed MARKETING_VERSION.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { versionProblems } from './app-version.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

/** The files a release writes its numbers into (scripts/app-version.mjs and scripts/ios-build-number.mjs). */
export const VERSION_FILES = ['package.json', 'package-lock.json', 'ios/App/App.xcodeproj/project.pbxproj', 'src/appversion.ts']

/**
 * The changed paths `git status --porcelain -z` lists, tracked or not, staged
 * or not. A rename or copy names the path it came from too.
 * @param {string} porcelain
 * @returns {string[]}
 */
export function changedPaths(porcelain) {
  const fields = porcelain.split('\0')
  /** @type {string[]} */
  const paths = []
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (!entry) continue
    paths.push(entry.slice(3))
    if (/[RC]/.test(entry.slice(0, 2)) && fields[i + 1]) paths.push(fields[++i])
  }
  return paths
}

/**
 * A version file with its numbers blanked, so two copies of it that differ
 * only in those compare equal: the version in package.json and at the root of
 * the lockfile, MARKETING_VERSION and CURRENT_PROJECT_VERSION in Xcode, and
 * APP_VERSION. A dependency moved in the lockfile is not the root's version.
 * @param {string} path
 * @param {string} text
 */
export function withoutVersions(path, text) {
  if (path.endsWith('.json')) {
    const json = JSON.parse(text)
    delete json.version
    if (json.packages?.['']) delete json.packages[''].version
    return JSON.stringify(json)
  }
  return text.replace(/\b(MARKETING_VERSION|CURRENT_PROJECT_VERSION) = [\d.]+;/g, '$1 = ?;').replace(/\bAPP_VERSION = '[\d.]+'/g, "APP_VERSION = '?'")
}

/**
 * Whether a release may build over this change: a version file whose only
 * change from the last commit is its numbers.
 * @param {string} path
 * @param {string | null} committed the file at HEAD, or null when it is new
 * @param {string} current
 */
export function onlyNumbersChanged(path, committed, current) {
  if (!VERSION_FILES.includes(path) || committed === null) return false
  try {
    return withoutVersions(path, committed) === withoutVersions(path, current)
  } catch {
    return false
  }
}

/**
 * @param {string} cmd
 * @param {string[]} cmdArgs
 */
function run(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit' })
  // a command that could not even start has no status: that is a failure too
  if (result.status !== 0) process.exit(result.status || 1)
}

/** @param {string[]} gitArgs */
function git(gitArgs) {
  return spawnSync('git', gitArgs, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const keep = args.includes('--keep')
  const skipTests = args.includes('--skip-tests')
  const bump = keep ? null : args.includes('--major') ? '--major' : args.includes('--minor') ? '--minor' : '--patch'

  const status = git(['status', '--porcelain', '-z', '--untracked-files=all'])
  if (status.status !== 0) {
    console.error(`ios-release: git could not say what is changed, so nothing was built: ${(status.stderr || status.error?.message || '').trim()}`)
    process.exit(1)
  }
  const stray = changedPaths(status.stdout).filter(path => {
    if (!VERSION_FILES.includes(path)) return true
    const committed = git(['show', `HEAD:${path}`])
    /** @type {string | null} deleted, if it cannot be read */
    let current = null
    try {
      current = readFileSync(`${root}/${path}`, 'utf8')
    } catch {}
    return current === null || !onlyNumbersChanged(path, committed.status === 0 ? committed.stdout : null, current)
  })
  if (stray.length) {
    console.error(
      `ios-release: changed and not committed, so the phone would get what no commit holds:\n  ${stray.join('\n  ')}\n` +
        'Commit them or put them aside, then run it again. Nothing was raised or built.',
    )
    process.exit(1)
  }

  if (skipTests) console.warn('ios-release: --skip-tests: building WITHOUT running the unit tests.')
  else run('npx', ['vitest', 'run'])

  if (bump) run(process.execPath, ['scripts/app-version.mjs', bump])
  run(process.execPath, ['scripts/ios-build-number.mjs'])

  // the app and its widget must go up together, or the upload is refused at the very end
  const problems = versionProblems(readFileSync(`${root}/ios/App/App.xcodeproj/project.pbxproj`, 'utf8'))
  if (problems.length) {
    console.error(`ios-release: the app and its widget disagree:\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }

  run('npm', ['run', 'build:ios'])
  run('npx', ['cap', 'open', 'ios'])
}
