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
// Xcode Cloud never runs this. It sets the build number from CI_BUILD_NUMBER
// and keeps the committed MARKETING_VERSION.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { versionProblems } from './app-version.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const keep = args.includes('--keep')
const bump = keep ? null : args.includes('--major') ? '--major' : args.includes('--minor') ? '--minor' : '--patch'

function run(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit' })
  if (result.status) process.exit(result.status ?? 1)
}

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
