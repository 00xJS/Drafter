#!/usr/bin/env node
// Put a new build on a phone: raise the version people read (unless asked
// not to), raise Apple's build number, rebuild the bundle, open Xcode.
//
//   npm run release:ios              1.0.1 and build N+1  (a small drop)
//   npm run release:ios -- --minor   1.1.0
//   npm run release:ios -- --major   2.0.0
//   npm run release:ios -- --keep    same 1.0.1, new build number only
//
// Xcode Cloud never runs this. It sets the build number from CI_BUILD_NUMBER
// and keeps the committed MARKETING_VERSION.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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
run('npm', ['run', 'build:ios'])
run('npx', ['cap', 'open', 'ios'])
