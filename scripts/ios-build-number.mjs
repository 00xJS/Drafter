#!/usr/bin/env node
// Raise the iOS build number, in both build configurations.
//
// App Store Connect refuses an upload whose CURRENT_PROJECT_VERSION it has
// already seen for this MARKETING_VERSION — and it refuses it AFTER the
// archive, the export and the upload have all run, which is several minutes
// spent to be told to change one integer and do it again. `npm run release:ios`
// raises it first so that cannot happen.
//
// The number is Apple's build, not a version anyone reads: it only has to go
// up. MARKETING_VERSION (1.0) is the one shown in the App Store and on the
// TestFlight card, and this never touches it — raise that by hand when a
// release deserves a new name.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const path = fileURLToPath(new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url))
const pbx = readFileSync(path, 'utf8')

const found = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map(m => Number(m[1]))
if (found.length === 0) {
  console.error('ios-build-number: no CURRENT_PROJECT_VERSION in the Xcode project — has the project layout changed?')
  process.exit(1)
}

// every configuration moves to the same number: Debug and Release differing is
// how you upload a build whose number is not the one you just raised
const next = Math.max(...found) + 1
writeFileSync(path, pbx.replace(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${next};`))

const marketing = /MARKETING_VERSION = ([\d.]+);/.exec(pbx)?.[1] ?? '?'
console.log(`ios-build-number: ${found.join(', ')} -> ${next} (version ${marketing}, ${found.length} configurations)`)
