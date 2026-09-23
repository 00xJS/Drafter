#!/usr/bin/env node
// Set the iOS build number, in both build configurations.
//
// With no argument it raises the stored number by one, which is what
// `npm run release:ios` wants. With `--set <n>` it writes that number instead,
// which is what Xcode Cloud wants: the cloud has its own build counter
// (CI_BUILD_NUMBER) and it, not this file, is what App Store Connect has
// already seen for the builds it produced.
//
// App Store Connect refuses an upload whose CURRENT_PROJECT_VERSION it has
// already seen for this MARKETING_VERSION — and it refuses it AFTER the
// archive, the export and the upload have all run, which is several minutes
// spent to be told to change one integer and do it again. `npm run release:ios`
// raises it first so that cannot happen.
//
// The number is Apple's build, not a version anyone reads: it only has to go
// up. MARKETING_VERSION (1.0.1) is the one shown in Settings, TestFlight and
// the App Store — scripts/app-version.mjs raises that; this never touches it.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const path = fileURLToPath(new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url))
const pbx = readFileSync(path, 'utf8')

const found = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map(m => Number(m[1]))
if (found.length === 0) {
  console.error('ios-build-number: no CURRENT_PROJECT_VERSION in the Xcode project — has the project layout changed?')
  process.exit(1)
}

const flag = process.argv.indexOf('--set')
const asked = flag === -1 ? null : Number(process.argv[flag + 1])
if (asked !== null && (!Number.isInteger(asked) || asked < 1)) {
  console.error(`ios-build-number: --set wants a positive whole number, got ${process.argv[flag + 1]}`)
  process.exit(1)
}

// every configuration moves to the same number: Debug and Release differing is
// how you upload a build whose number is not the one you just raised
const next = asked ?? Math.max(...found) + 1
writeFileSync(path, pbx.replace(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${next};`))

const marketing = /MARKETING_VERSION = ([\d.]+);/.exec(pbx)?.[1] ?? '?'
console.log(`ios-build-number: ${found.join(', ')} -> ${next}${asked ? ' (set)' : ''} (version ${marketing}, ${found.length} configurations)`)
