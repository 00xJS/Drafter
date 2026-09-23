// Every variable the app's code reads is cleared by the test setup (setup.ts),
// so a test sees the same environment on a laptop, on GitHub and on Netlify,
// whose build carries the site's real settings. Twice a variable the setup did
// not name failed only the build that ships: BACKUP_PASSPHRASE on 2026-09-21,
// ANTHROPIC_API_KEY on 2026-09-23. A new read now fails here, on every machine.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NVIDIA_KEY_NAME } from '../../netlify/functions/lib/ai.mjs'
import { decidedHere, NVIDIA_KEYS_DECIDED_HERE } from './setup'

/** Where the app's code lives: the functions, what they share with the app, the connector, the scripts, the app, the bot. */
const ROOTS = ['netlify/functions', 'shared', 'mcp', 'scripts', 'src', 'supabase/functions']

/** process.env.NAME, process.env['NAME'], and Netlify's and Deno's env.get('NAME'). */
const READS = /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]|(?:Netlify|Deno)\.env\.get\(['"]([A-Z][A-Z0-9_]*)['"]\)/g

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') yield* sources(path)
    } else if (/\.(?:m?[jt]s|tsx)$/.test(entry.name)) yield path
  }
}

describe('the environment a test sees', () => {
  it('is decided by the setup for every variable the code reads', () => {
    const reads = new Map<string, string>()
    for (const root of ROOTS)
      for (const file of sources(root))
        for (const match of readFileSync(file, 'utf8').matchAll(READS)) {
          const name = match[1] ?? match[2] ?? match[3]
          if (!reads.has(name)) reads.set(name, file)
        }
    expect(reads.size).toBeGreaterThan(20)
    expect([...reads].filter(([name]) => !decidedHere(name)).map(([name, file]) => `${name}, read in ${file}`)).toEqual([])
  })

  it('names the NVIDIA keys as the server reads them', () => {
    expect(NVIDIA_KEYS_DECIDED_HERE.source).toBe(NVIDIA_KEY_NAME.source)
  })

  it('holds none of them from the host once a test runs', () => {
    expect(Object.keys(process.env).filter(decidedHere)).toEqual([])
  })
})
