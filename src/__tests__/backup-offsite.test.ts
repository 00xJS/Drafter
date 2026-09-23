import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KEEP_DAYS, LABEL, copiesToPrune, cutoffDay, defaultPaths, launchAgentPlist, listedNames, logLine, main } from '../../scripts/backup-offsite.mjs'
import type { Cli } from '../../scripts/backup-offsite.mjs'

// The nightly snapshots live in the same Supabase project as what they back
// up. scripts/backup-offsite.mjs keeps copies in iCloud Drive on the owner's
// Mac, through the Supabase CLI already linked there — and only the ENCRYPTED
// ones: a snapshot written before BACKUP_PASSPHRASE holds the journal in the
// clear and never goes to iCloud. Every path and the CLI itself are handed in
// here; nothing touches the real bucket, iCloud or the owner's log.

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const NOW = new Date('2026-09-22T10:30:00.000Z')
const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/+$/, '')

/** A snapshot as the nightly job writes it: an envelope under the passphrase, or plain JSON from before. */
const envelope = (userId: string) => JSON.stringify({ drafterBackup: 1, alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations: 310000, salt: 's', iv: 'i', ct: 'Y2lwaGVy', userId, exportedAt: NOW.toISOString(), items: null })
const plain = (userId: string) => JSON.stringify({ exportedAt: NOW.toISOString(), userId, items: [{ kind: 'journal', body: 'the private bit' }] })

let home: string
let cloud: string
let dest: string
let log: string
let tmp: string
/** The bucket: backups/<account>/<date>.json → the file's text. */
let bucket: Map<string, string>
let calls: string[][]
let brokenFor: string | null

/**
 * The CLI as far as this script uses it: `storage ls` prints one name a line,
 * folders with a trailing slash; `storage cp` writes the object to the path it
 * is given. Both expect the storage flags every call must carry.
 */
const fakeCli: Cli = async args => {
  calls.push(args)
  const [group, cmd, ...rest] = args
  const flags = rest.filter(a => a.startsWith('--'))
  const paths = rest.filter(a => !a.startsWith('--'))
  if (group !== 'storage' || flags.join(' ') !== '--experimental --linked') throw new Error(`unexpected supabase ${args.join(' ')}`)
  const key = (p: string) => p.replace(/^ss:\/\/\/media\//, '')
  if (brokenFor && paths.some(p => p.includes(brokenFor!))) throw new Error('supabase storage failed: 503 Service Unavailable')
  if (cmd === 'ls') {
    const prefix = key(paths[0])
    const names = new Set<string>()
    for (const k of bucket.keys()) {
      if (!k.startsWith(prefix)) continue
      const tail = k.slice(prefix.length)
      names.add(tail.includes('/') ? tail.slice(0, tail.indexOf('/') + 1) : tail)
    }
    return `${[...names].join('\n')}\n`
  }
  if (cmd === 'cp') {
    const body = bucket.get(key(paths[0]))
    if (body === undefined) throw new Error('object not found')
    await writeFile(paths[1], body)
    return `Downloading: ${paths[0]} => ${paths[1]}\n`
  }
  throw new Error(`unexpected supabase ${args.join(' ')}`)
}

const quiet = { log: () => {}, error: () => {} }
const run = (argv: string[] = [], cli: Cli | null = fakeCli) => main(['--dest', dest, '--log', log, ...argv], { home, cli, now: NOW, tmp, out: quiet })
const here = async (account: string) => (await readdir(join(dest, account))).sort()

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'drafter-offsite-test-'))
  cloud = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
  dest = join(cloud, 'Drafter Backups')
  log = join(home, 'Library', 'Logs', 'drafter-backup-offsite.log')
  tmp = join(home, 'tmp')
  await mkdir(cloud, { recursive: true })
  await mkdir(tmp, { recursive: true })
  calls = []
  brokenFor = null
  bucket = new Map([
    [`backups/${A}/2026-09-20.json`, plain(A)],
    [`backups/${A}/2026-09-21.json`, envelope(A)],
    [`backups/${A}/2026-09-22.json`, envelope(A)],
    [`backups/${B}/2026-09-22.json`, envelope(B)],
  ])
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('the nightly copy into iCloud Drive', () => {
  it('copies the encrypted snapshots, never a plain one, and says so in the log', async () => {
    expect(await run()).toBe(0)
    expect(await here(A)).toEqual(['2026-09-21.json', '2026-09-22.json'])
    expect(await here(B)).toEqual(['2026-09-22.json'])
    expect(await readFile(join(dest, A, '2026-09-22.json'), 'utf8')).toBe(envelope(A))
    // private to the owner on this Mac, and nothing left behind in the temporary folder
    expect((await stat(join(dest, A, '2026-09-22.json'))).mode & 0o777).toBe(0o600)
    expect(await readdir(tmp)).toEqual([])
    const lines = (await readFile(log, 'utf8')).trim().split('\n')
    expect(lines).toEqual(['2026-09-22T10:30:00.000Z ok: 2 account(s): copied 3, already here 0, skipped 1 unencrypted'])
  })

  it('downloads only what is not here yet, counting iCloud’s stand-in for a copy it moved off this Mac', async () => {
    await run()
    await rm(join(dest, B, '2026-09-22.json'))
    await writeFile(join(dest, B, '.2026-09-22.json.icloud'), '')
    calls = []
    expect(await run()).toBe(0)
    // the plain one is looked at again (it is never kept), nothing else is fetched
    expect(calls.filter(c => c[1] === 'cp').map(c => c[4])).toEqual([`ss:///media/backups/${A}/2026-09-20.json`])
    expect((await readFile(log, 'utf8')).trim().split('\n')[1]).toBe('2026-09-22T10:30:00.000Z ok: 2 account(s): copied 0, already here 3, skipped 1 unencrypted')
  })

  it('keeps sixty days, by the date in the name, and touches nothing else in the folder', async () => {
    await mkdir(join(dest, A), { recursive: true })
    const cutoff = cutoffDay(NOW)
    expect(cutoff).toBe('2026-07-24')
    for (const name of ['2026-07-23.json', '2026-07-24.json', '.2026-07-01.json.icloud', 'notes.txt', '2026-07-01.json.bak']) await writeFile(join(dest, A, name), 'x')
    // a folder the bucket no longer lists (an account deleted since) is pruned all the same
    await mkdir(join(dest, '00000000-0000-4000-8000-0000000000ff'), { recursive: true })
    await writeFile(join(dest, '00000000-0000-4000-8000-0000000000ff', '2026-06-01.json'), 'x')
    // an old snapshot still in the bucket is not fetched only to be pruned again
    bucket.set(`backups/${A}/2026-07-01.json`, envelope(A))
    expect(await run()).toBe(0)
    expect(await here(A)).toEqual(['2026-07-01.json.bak', '2026-07-24.json', '2026-09-21.json', '2026-09-22.json', 'notes.txt'])
    expect(await readdir(join(dest, '00000000-0000-4000-8000-0000000000ff'))).toEqual([])
    expect(calls.some(c => c.some(a => a.includes('2026-07-01')))).toBe(false)
    expect(copiesToPrune(['2026-07-23.json', '.2026-07-23.json.icloud', '2026-07-24.json', 'x.json'], NOW)).toEqual(['2026-07-23.json', '.2026-07-23.json.icloud'])
    expect(KEEP_DAYS).toBe(60)
  })

  it('carries on past an account it cannot read, and fails the run for it', async () => {
    brokenFor = `backups/${A}/`
    expect(await run()).toBe(1)
    expect(await here(B)).toEqual(['2026-09-22.json'])
    expect((await readFile(log, 'utf8')).trim()).toBe(
      `2026-09-22T10:30:00.000Z FAILED: 2 account(s): copied 1, already here 0; ${A}: supabase storage failed: 503 Service Unavailable`,
    )
  })

  it('fails, and says why, when iCloud Drive is off or the bucket lists nothing', async () => {
    await rm(cloud, { recursive: true })
    expect(await run()).toBe(1)
    expect(await readFile(log, 'utf8')).toMatch(/FAILED: iCloud Drive is not on/)
    expect(calls).toEqual([])

    await mkdir(cloud, { recursive: true })
    bucket.clear()
    expect(await run()).toBe(1)
    expect(await readFile(log, 'utf8')).toMatch(/FAILED: found no backups under media\/backups\/ — is this checkout linked to the right project/)
  })

  it('drops a copy an earlier run did not finish moving in', async () => {
    await mkdir(join(dest, A), { recursive: true })
    await writeFile(join(dest, A, '2026-09-22.json.partial'), 'half')
    expect(await run()).toBe(0)
    expect(await here(A)).toEqual(['2026-09-21.json', '2026-09-22.json'])
  })

  it('reads the names the CLI prints, whole paths or not, and nothing else it says', () => {
    expect(listedNames(`${A}/\n\n/media/backups/${B}/\n2026-09-21.json\n  /media/backups/${A}/2026-09-22.json  \n`)).toEqual([`${A}/`, `${B}/`, '2026-09-21.json', '2026-09-22.json'])
    expect(logLine(NOW, null, 'boom')).toBe('2026-09-22T10:30:00.000Z FAILED: boom')
  })

  it('refuses arguments it does not know, and needs a value where one is due', async () => {
    expect(await main(['--nope'], { home, out: quiet })).toBe(2)
    expect(await main(['--dest'], { home, out: quiet })).toBe(2)
    expect(await main(['--keep-days', '0'], { home, out: quiet })).toBe(2)
  })
})

// these spawn real node processes, which a busy machine can make slow to start
describe('the real command runner, against a stand-in supabase', { timeout: 30_000 }, () => {
  it('runs the CLI in this checkout with the storage flags, and copies what it downloads', async () => {
    const bin = join(home, 'bin')
    await mkdir(bin, { recursive: true })
    const store = join(home, 'store')
    for (const [key, body] of bucket) {
      await mkdir(join(store, key, '..'), { recursive: true })
      await writeFile(join(store, key), body)
    }
    const seen = join(home, 'seen.jsonl')
    // a CommonJS script, as a file with no extension is to node
    const fake = join(bin, 'supabase')
    await writeFile(
      fake,
      `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n')
const at = p => path.join(${JSON.stringify(store)}, p.replace(/^ss:\\/\\/\\/media\\//, ''))
const paths = args.filter(a => !a.startsWith('--'))
if (args[1] === 'ls') {
  for (const e of fs.readdirSync(at(paths[paths.length - 1]), { withFileTypes: true })) console.log(e.isDirectory() ? e.name + '/' : e.name)
} else if (args[1] === 'cp') {
  fs.copyFileSync(at(paths[paths.length - 2]), paths[paths.length - 1])
} else {
  console.error('unknown command')
  process.exit(1)
}
`,
    )
    await chmod(fake, 0o755)

    expect(await run(['--supabase', fake], null)).toBe(0)
    expect(await here(A)).toEqual(['2026-09-21.json', '2026-09-22.json'])
    const invocations = (await readFile(seen, 'utf8')).trim().split('\n').map(l => JSON.parse(l) as { args: string[]; cwd: string })
    expect(invocations[0]).toEqual({ args: ['storage', 'ls', '--experimental', '--linked', 'ss:///media/backups/'], cwd: ROOT })
    expect(invocations.find(i => i.args[1] === 'cp')!.args.slice(0, 5)).toEqual(['storage', 'cp', '--experimental', '--linked', `ss:///media/backups/${A}/2026-09-20.json`])

    // and a CLI that fails is a failed night, with the end of what it said
    await writeFile(fake, '#!/usr/bin/env node\nconsole.error("Access token not provided. Supply an access token by running supabase login")\nprocess.exit(1)\n')
    expect(await run(['--supabase', fake], null)).toBe(1)
    expect((await readFile(log, 'utf8')).trim().split('\n').pop()).toMatch(/FAILED: supabase storage ls failed: Access token not provided/)
  })
})

describe('the LaunchAgent', () => {
  it('runs the script nightly at 03:30 with node, the CLI and this checkout named in full, and not at load', () => {
    const plist = launchAgentPlist({ node: '/opt/homebrew/bin/node', supabase: '/opt/homebrew/bin/supabase', script: '/Users/o/Project Planner & Co/scripts/backup-offsite.mjs', repo: '/Users/o/Project Planner & Co', log: '/Users/o/Library/Logs/drafter-backup-offsite.log' })
    expect(plist).toContain(`<key>Label</key>\n  <string>${LABEL}</string>`)
    expect(plist).toContain(
      '<array>\n    <string>/opt/homebrew/bin/node</string>\n    <string>/Users/o/Project Planner &amp; Co/scripts/backup-offsite.mjs</string>\n    <string>--supabase</string>\n    <string>/opt/homebrew/bin/supabase</string>\n  </array>',
    )
    expect(plist).toContain('<key>WorkingDirectory</key>\n  <string>/Users/o/Project Planner &amp; Co</string>')
    expect(plist).toContain('<key>Hour</key>\n    <integer>3</integer>\n    <key>Minute</key>\n    <integer>30</integer>')
    expect(plist).toContain('<key>RunAtLoad</key>\n  <false/>')
    expect(plist).toContain('<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>')
    expect(plist).toContain('<key>StandardErrorPath</key>\n  <string>/Users/o/Library/Logs/drafter-backup-offsite.log</string>')
    expect(plist).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/)
  })

  it('is what --launch-agent prints, for the installer to write', async () => {
    const printed: string[] = []
    expect(await main(['--launch-agent', '--node', '/usr/local/bin/node', '--supabase', '/usr/local/bin/supabase'], { home, out: { log: (s: string) => printed.push(s), error: () => {} } })).toBe(0)
    expect(printed).toHaveLength(1)
    expect(printed[0]).toContain(`<string>${ROOT}/scripts/backup-offsite.mjs</string>`)
    expect(printed[0]).toContain(`<string>${defaultPaths(home).log}</string>`)
    expect(await main(['--launch-agent', '--node', '/usr/local/bin/node'], { home, out: quiet })).toBe(2)
  })

  it('puts everything under the owner’s own Library and iCloud Drive', () => {
    expect(defaultPaths('/Users/o')).toEqual({
      cloud: '/Users/o/Library/Mobile Documents/com~apple~CloudDocs',
      dest: '/Users/o/Library/Mobile Documents/com~apple~CloudDocs/Drafter Backups',
      log: '/Users/o/Library/Logs/drafter-backup-offsite.log',
    })
  })
})
