import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gate } from '../../scripts/netlify-ignore.mjs'

// Gated deploys: with DRAFTER_GATED_DEPLOYS=1 on Netlify, a push to main is not
// built until CI has passed and calls the build hook. Unset, nothing changes.
// Each case hands gate() the environment it is about, never the machine's.

const SCRIPT = fileURLToPath(new URL('../../scripts/netlify-ignore.mjs', import.meta.url))
const push = { BRANCH: 'main', HEAD: 'main', COMMIT_REF: 'abc123', CACHED_COMMIT_REF: 'abc122', PULL_REQUEST: 'false' }
const on = { ...push, DRAFTER_GATED_DEPLOYS: '1' }

describe('the gate Netlify asks before building a push', () => {
  it('builds every push while the switch is off, as before the gate existed', () => {
    expect(gate(push).skip).toBe(false)
    for (const value of ['', '0', 'true', 'yes', ' 1']) expect(gate({ ...push, DRAFTER_GATED_DEPLOYS: value }).skip, value).toBe(false)
    expect(gate({}).skip).toBe(false)
  })

  it('holds a push to main back once the switch is on', () => {
    const answer = gate(on)
    expect(answer.skip).toBe(true)
    expect(answer.why).toContain('build hook')
  })

  it('always builds what the build hook started: CI has passed', () => {
    expect(gate({ ...on, INCOMING_HOOK_TITLE: 'CI passed', INCOMING_HOOK_URL: 'https://api.netlify.com/build_hooks/x', INCOMING_HOOK_BODY: '{}' }).skip).toBe(false)
    expect(gate({ ...on, INCOMING_HOOK_URL: 'https://api.netlify.com/build_hooks/x' }).skip).toBe(false)
    expect(gate({ ...on, INCOMING_HOOK_TITLE: 'CI passed' }).why).toContain('"CI passed"')
  })

  it('never holds back a branch or a pull request, which the hook would never build', () => {
    expect(gate({ ...on, BRANCH: 'rf/w3-ci', HEAD: 'rf/w3-ci' }).skip).toBe(false)
    expect(gate({ ...on, BRANCH: 'main', PULL_REQUEST: 'true' }).skip).toBe(false)
    expect(gate({ DRAFTER_GATED_DEPLOYS: '1' }).skip).toBe(false)
  })

  it('answers Netlify in exit codes: 0 skips, 1 builds', () => {
    const run = (env: Record<string, string>) => {
      try {
        execFileSync(process.execPath, [SCRIPT], { env, stdio: 'pipe' })
        return 0
      } catch (e) {
        return (e as { status: number }).status
      }
    }
    expect(run(on)).toBe(0)
    expect(run(push)).toBe(1)
    expect(run({ ...on, INCOMING_HOOK_TITLE: 'CI passed' })).toBe(1)
  })
})
