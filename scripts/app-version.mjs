#!/usr/bin/env node
// The version people read: Settings, TestFlight, the App Store card.
//
// Apple has two numbers. CURRENT_PROJECT_VERSION (scripts/ios-build-number.mjs)
// is the integer Connect refuses to see twice — it only has to go up.
// MARKETING_VERSION is the name on the phone: 1.0.1 for a small drop, 1.1.0
// for a feature, 2.0.0 for a break. This script is the one place that name
// is raised, and it writes every copy so they cannot drift: package.json,
// the lockfile's root, Xcode, and src/appversion.ts (what Settings reads
// on the web).
//
//   npm run version:patch   1.0.0 → 1.0.1
//   npm run version:minor   1.0.1 → 1.1.0
//   npm run version:major   1.1.0 → 2.0.0
//   node scripts/app-version.mjs --set 1.2.0
//   node scripts/app-version.mjs          print what is stored
//
// `npm run release:ios` runs a patch bump unless you pass --keep / --minor
// / --major, so a phone install is never another anonymous "1.0".

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { bumpVersion, formatVersion, parseVersion } from '../shared/appversion.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PKG = `${ROOT}/package.json`
const LOCK = `${ROOT}/package-lock.json`
const PBX = `${ROOT}/ios/App/App.xcodeproj/project.pbxproj`
const TS = `${ROOT}/src/appversion.ts`

export function readStoredVersion() {
  const pbx = readFileSync(PBX, 'utf8')
  const found = [...pbx.matchAll(/MARKETING_VERSION = ([\d.]+);/g)].map(m => m[1])
  if (found.length === 0) return null
  const parts = parseVersion(found[0]) ?? [0, 0, 0]
  return formatVersion(parts)
}

function writeAll(next) {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
  const prevPkg = pkg.version
  const prev = readStoredVersion() ?? prevPkg

  pkg.version = next
  writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`)

  // only the root package — a blanket replace would catch a dependency that
  // happens to share the old number. package.json and Xcode can disagree
  // (they did: 0.1.0 vs 1.0) so the lock follows package.json's old value.
  let lock = readFileSync(LOCK, 'utf8')
  lock = lock.replace(`"name": "drafter",\n  "version": "${prevPkg}"`, `"name": "drafter",\n  "version": "${next}"`)
  lock = lock.replace(`"name": "drafter",\n      "version": "${prevPkg}"`, `"name": "drafter",\n      "version": "${next}"`)
  writeFileSync(LOCK, lock)

  const pbx = readFileSync(PBX, 'utf8')
  writeFileSync(PBX, pbx.replace(/MARKETING_VERSION = [\d.]+;/g, `MARKETING_VERSION = ${next};`))

  writeFileSync(
    TS,
    `/** The version people read. Written by scripts/app-version.mjs — do not edit. */\nexport const APP_VERSION = '${next}'\n`,
  )
  return prev
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  const args = process.argv.slice(2)
  const setAt = args.indexOf('--set')
  const kind = args.includes('--major') ? 'major' : args.includes('--minor') ? 'minor' : args.includes('--patch') ? 'patch' : null
  const current = readStoredVersion()
  if (!current) {
    console.error('app-version: no MARKETING_VERSION in the Xcode project — has the project layout changed?')
    process.exit(1)
  }

  if (setAt === -1 && !kind) {
    console.log(`app-version: ${current}`)
    process.exit(0)
  }

  let next
  if (setAt !== -1) {
    const asked = args[setAt + 1]
    const parts = parseVersion(asked)
    next = parts && formatVersion(parts)
    if (!next) {
      console.error(`app-version: --set wants a version like 1.0.1, got ${asked}`)
      process.exit(1)
    }
  } else {
    next = bumpVersion(current, kind)
  }

  const prev = writeAll(next)
  const pbx = readFileSync(PBX, 'utf8')
  const copies = [...pbx.matchAll(/MARKETING_VERSION = ([\d.]+);/g)].length
  console.log(`app-version: ${prev} -> ${next} (${copies} Xcode configurations)`)
}
