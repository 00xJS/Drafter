import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import {
  KEEP_DAYS,
  LABEL,
  PINNED_FILES,
  copiesToPrune,
  cutoffDay,
  defaultPaths,
  launchAgentPlist,
  listedNames,
  logLine,
  macNotifier,
  main,
  newestCopyDay,
  notificationArgs,
  pinCopy,
  staleCheck,
} from '../../scripts/backup-offsite.mjs'
import type { Cli, Notify } from '../../scripts/backup-offsite.mjs'

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
/** A run with a notifier that only writes down what it would have shown. */
let shown: [string, string][]
const noticing: Notify = async (title, message) => {
  shown.push([title, message])
  return true
}
const runAt = (now: Date, cli: Cli = fakeCli) => main(['--dest', dest, '--log', log], { home, cli, now, tmp, out: quiet, notify: noticing })
const DAY = 86_400_000
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
  shown = []
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
      pinned: '/Users/o/Library/Application Support/Drafter/offsite',
      state: '/Users/o/Library/Application Support/Drafter/offsite-state.json',
    })
  })
})

describe('when a night goes wrong, the Mac says so', () => {
  it('shows a notification for a failed night, and none for one that worked', async () => {
    expect(await runAt(NOW)).toBe(0)
    expect(shown).toEqual([])

    brokenFor = `backups/${A}/`
    expect(await runAt(NOW)).toBe(1)
    expect(shown).toEqual([['Drafter off-site backup failed', `1 of 2 account(s) failed: ${A}: supabase storage failed: 503 Service Unavailable — see ~/Library/Logs/drafter-backup-offsite.log`]])

    shown = []
    await rm(cloud, { recursive: true })
    expect(await runAt(NOW)).toBe(1)
    expect(shown).toHaveLength(1)
    expect(shown[0][1]).toMatch(/^iCloud Drive is not on/)
  })

  it('warns once a week while the newest copy is more than three days old, and says how old', async () => {
    // a night that works and copies nothing: the server wrote no new snapshot
    const stale = new Map([[`backups/${A}/2026-09-15.json`, envelope(A)]])
    bucket = stale
    const week = new Date('2026-09-15T10:30:00.000Z')
    expect(await runAt(week)).toBe(0)
    expect(shown).toEqual([])
    // four days on, nothing newer came
    expect(await runAt(new Date(week.getTime() + 4 * DAY))).toBe(0)
    expect(shown).toEqual([['Drafter off-site backup is behind', 'The newest off-site copy is 4 days old (2026-09-15). See ~/Library/Logs/drafter-backup-offsite.log.']])
    expect((await readFile(log, 'utf8')).trim().split('\n').pop()).toBe('2026-09-19T10:30:00.000Z STALE: The newest off-site copy is 4 days old (2026-09-15).')
    // not every night: the next six say nothing more
    for (let d = 5; d <= 10; d++) await runAt(new Date(week.getTime() + d * DAY))
    expect(shown).toHaveLength(1)
    // a week after the last warning, again
    await runAt(new Date(week.getTime() + 11 * DAY))
    expect(shown.map(s => s[1])).toEqual([
      'The newest off-site copy is 4 days old (2026-09-15). See ~/Library/Logs/drafter-backup-offsite.log.',
      'The newest off-site copy is 11 days old (2026-09-15). See ~/Library/Logs/drafter-backup-offsite.log.',
    ])
    // copies arrive again: the warning is forgotten, so the next time they stop it comes at once
    bucket.set(`backups/${A}/2026-09-27.json`, envelope(A))
    await runAt(new Date('2026-09-27T10:30:00.000Z'))
    expect(JSON.parse(await readFile(defaultPaths(home).state, 'utf8'))).toEqual({ staleWarnedAt: null })
    await runAt(new Date('2026-10-01T10:30:00.000Z'))
    expect(shown).toHaveLength(3)
    expect(shown[2][1]).toMatch(/^The newest off-site copy is 4 days old \(2026-09-27\)/)
  })

  it('says so when no copy has ever reached iCloud Drive', async () => {
    // every snapshot written before encryption was on: none may go to iCloud
    bucket = new Map([[`backups/${A}/2026-09-22.json`, plain(A)]])
    expect(await runAt(NOW)).toBe(0)
    expect(shown).toEqual([['Drafter off-site backup is behind', 'There is no off-site copy in iCloud Drive yet. See ~/Library/Logs/drafter-backup-offsite.log.']])
  })

  it('draws the lines at three days old and a week between warnings', () => {
    const now = '2026-09-22T03:30:00.000Z'
    expect(staleCheck({ newest: '2026-09-19', now })).toEqual({ stale: false, ageDays: 3, warn: false })
    expect(staleCheck({ newest: '2026-09-18', now })).toEqual({ stale: true, ageDays: 4, warn: true })
    expect(staleCheck({ newest: null, now })).toEqual({ stale: true, ageDays: null, warn: true })
    expect(staleCheck({ newest: '2026-09-01', now, lastWarnedAt: '2026-09-16T03:30:00.001Z' }).warn).toBe(false)
    expect(staleCheck({ newest: '2026-09-01', now, lastWarnedAt: '2026-09-15T03:30:00.000Z' }).warn).toBe(true)
    expect(newestCopyDay(['2026-09-01.json', '.2026-09-20.json.icloud', 'notes.txt', '2026-09-19.json.partial'])).toBe('2026-09-20')
    expect(newestCopyDay([])).toBeNull()
  })

  it('hands osascript the words as arguments, never as part of its script', async () => {
    const args = notificationArgs('Drafter "off-site"', `it said: "end run" \\ do shell script "rm -rf ~"\n${'x'.repeat(500)}`)
    expect(args.slice(0, 6)).toEqual(['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run'])
    expect(args[6]).toBe('Drafter "off-site"')
    expect(args[7]).toMatch(/^it said: "end run" \\ do shell script "rm -rf ~" x+$/)
    expect(args[7].length).toBeLessThanOrEqual(240)
    const ran: { bin: string; args: string[] }[] = []
    const fake = (bin: string, a: string[], _o: unknown, done: (err: Error | null) => void) => {
      ran.push({ bin, args: a })
      done(null)
    }
    expect(await macNotifier({ run: fake, os: 'darwin' })('Title', 'Body')).toBe(true)
    expect(ran).toEqual([{ bin: '/usr/bin/osascript', args: notificationArgs('Title', 'Body') }])
    // anywhere but a Mac it shows nothing, and a notification that fails never fails the night
    expect(await macNotifier({ run: fake, os: 'linux' })('Title', 'Body')).toBe(false)
    expect(ran).toHaveLength(1)
    expect(await macNotifier({ run: (_b: string, _a: string[], _o: unknown, done: (err: Error | null) => void) => done(new Error('no GUI session')), os: 'darwin' })('T', 'B')).toBe(false)
  })
})

describe('the pinned copy the LaunchAgent runs', () => {
  /** A checkout of its own: the files the copy needs, and a link to a project. */
  async function checkout(linked = true) {
    const root = join(home, 'checkout')
    for (const rel of PINNED_FILES) {
      await mkdir(join(root, rel, '..'), { recursive: true })
      await writeFile(join(root, rel), `// ${rel}\n`)
    }
    if (linked) {
      await mkdir(join(root, 'supabase', '.temp'), { recursive: true })
      await writeFile(join(root, 'supabase', '.temp', 'project-ref'), 'abcdefghijklmnop')
      await writeFile(join(root, 'supabase', '.temp', 'pooler-url'), 'postgresql://postgres.abcdefghijklmnop@pooler.example:6543/postgres')
    }
    return root
  }

  it('holds the script, what it imports and the project link, and replaces the old copy whole', async () => {
    const from = await checkout()
    const to = join(home, 'Library', 'Application Support', 'Drafter', 'offsite')
    await mkdir(to, { recursive: true })
    await writeFile(join(to, 'left-from-last-time.mjs'), 'old')
    expect(await pinCopy({ from, to })).toEqual({
      files: [...PINNED_FILES, join('supabase', '.temp', 'pooler-url'), join('supabase', '.temp', 'project-ref')],
      linked: true,
    })
    expect(await readFile(join(to, 'scripts', 'backup-offsite.mjs'), 'utf8')).toBe('// scripts/backup-offsite.mjs\n')
    expect(await readFile(join(to, 'supabase', '.temp', 'project-ref'), 'utf8')).toBe('abcdefghijklmnop')
    await expect(stat(join(to, 'left-from-last-time.mjs'))).rejects.toThrow()
    // built beside it and moved in: nothing half-made is left behind
    expect((await readdir(join(to, '..'))).sort()).toEqual(['offsite'])
  })

  it('says when the checkout is not linked, and leaves the old copy alone when a file is missing', async () => {
    const from = await checkout(false)
    const to = join(home, 'pinned')
    expect((await pinCopy({ from, to })).linked).toBe(false)
    await rm(join(from, 'netlify'), { recursive: true })
    await expect(pinCopy({ from, to })).rejects.toThrow(/backupcrypto/)
    expect(await readFile(join(to, 'scripts', 'backup-offsite.mjs'), 'utf8')).toBe('// scripts/backup-offsite.mjs\n')
    expect((await readdir(home)).filter(n => n.startsWith('.pinned-'))).toEqual([])
  })

  it('from this checkout, runs on its own and names itself in the LaunchAgent it prints', { timeout: 30_000 }, async () => {
    const to = join(home, 'Application Support', 'offsite')
    const printed: string[] = []
    expect(await main(['--pin', to], { home, out: { log: (m: string) => printed.push(m), error: () => {} } })).toBe(0)
    expect(printed[0]).toMatch(new RegExp(`^Pinned \\d+ files into ${to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    // the copy's own imports resolve where it is: it prints its LaunchAgent, naming itself and its folder
    const plist = await new Promise<string>((resolve, reject) =>
      execFile(process.execPath, [join(to, 'scripts', 'backup-offsite.mjs'), '--launch-agent', '--node', '/opt/homebrew/bin/node', '--supabase', '/opt/homebrew/bin/supabase'], (err, stdout) =>
        err ? reject(err) : resolve(String(stdout)),
      ),
    )
    // by its real path: the one node reports as the script's own (macOS's /var is /private/var)
    const real = realpathSync(to)
    expect(plist).toContain(`<string>${join(real, 'scripts', 'backup-offsite.mjs')}</string>`)
    expect(plist).toContain(`<key>WorkingDirectory</key>\n  <string>${real}</string>`)
    expect(plist).not.toContain(ROOT)
  })
})
