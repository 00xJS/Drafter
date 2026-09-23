#!/usr/bin/env node
// Whether Netlify builds this push: netlify.toml's [build] ignore runs it
// before each build a git push starts. Exit 0 skips the build, exit 1 builds.
//
// Gated deploys (README → Deploy). Netlify builds main with `npm run check`,
// which has no Postgres and no browsers, so a push whose smoke or browser tests
// fail on GitHub still went live. With DRAFTER_GATED_DEPLOYS=1 set on Netlify,
// a push to main is skipped here instead, and CI's last job (.github/workflows/
// ci.yml, deploy) calls the site's build hook once every test has passed.
// Netlify never cancels a hook's build whatever this answers; the hook is
// checked here too so the rule reads whole in one place.
//
// With the variable unset every push builds, as before this file existed: the
// repository root is the base directory, so Netlify's own check only ever
// skipped a push that changed no file at all. A branch or a pull request is
// never held back: CI's hook only ever builds main.
//
// Netlify runs ignore commands on its own Node 18, before npm ci: no
// dependencies, nothing newer than Node 18 reads. If this throws, the exit
// code is 1 and the build goes ahead, as it would have without the gate.

import { fileURLToPath } from 'node:url'

/**
 * Whether this build is held back for CI, and why, in a line for the build log.
 * @param {Record<string, string | undefined>} env the build's environment
 * @returns {{ skip: boolean, why: string }}
 */
export function gate(env) {
  if (env.DRAFTER_GATED_DEPLOYS !== '1') return { skip: false, why: 'gated deploys are off (DRAFTER_GATED_DEPLOYS is not 1), so every push builds' }
  if (env.INCOMING_HOOK_URL || env.INCOMING_HOOK_TITLE) {
    return { skip: false, why: `started by the build hook${env.INCOMING_HOOK_TITLE ? ` "${env.INCOMING_HOOK_TITLE}"` : ''}: CI has passed` }
  }
  if (env.BRANCH !== 'main' || env.PULL_REQUEST === 'true') return { skip: false, why: `not main (${env.BRANCH ?? 'no branch'}), which is never held back` }
  return { skip: true, why: 'gated deploys are on: main is built when CI has passed every test and calls the build hook' }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { skip, why } = gate(process.env)
  console.log(`netlify-ignore: ${skip ? 'skipped' : 'building'}, ${why}`)
  process.exit(skip ? 0 : 1)
}
