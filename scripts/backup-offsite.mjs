#!/usr/bin/env node
// Off-site copies of the nightly backups, in iCloud Drive.
//
// The nightly snapshots (netlify/functions/lib/backup.mjs) live in the same
// Supabase project as everything they back up: the private `media` bucket,
// backups/<account id>/<YYYY-MM-DD>.json, the newest 14 per account. A project
// that is lost, deleted or locked takes its backups with it. This keeps copies
// somewhere else — iCloud Drive, on the owner's Mac — through the Supabase CLI
// that is already logged in and linked in this checkout.
//
//   node scripts/backup-offsite.mjs    copy what is new, prune what is old, log it
//
// A LaunchAgent runs it every night at 03:30 (scripts/install-offsite-backup.sh
// writes one). Each run:
//   1. lists media/backups/ and each account's snapshots (`supabase storage ls`);
//   2. downloads every snapshot of the last 60 days not already in
//      ~/Library/Mobile Documents/com~apple~CloudDocs/Drafter Backups/<account id>/
//      into a private temporary folder, and moves it into iCloud only if it is
//      ENCRYPTED — an envelope written under BACKUP_PASSPHRASE
//      (lib/backupcrypto.mjs). A plain snapshot, written before encryption was
//      turned on, holds the journal in the clear: it is deleted, counted, and
//      never reaches iCloud;
//   3. deletes copies older than 60 days, by the date in their names;
//   4. appends one line to ~/Library/Logs/drafter-backup-offsite.log, and exits
//      non-zero when anything failed — including finding no backups at all;
//   5. says so on screen, as a macOS notification, when anything failed, and
//      once a week while the newest copy here is more than 3 days old: a night
//      that "works" but copies nothing (no new snapshot, or only plain ones)
//      fails nobody's log, and only the age of the newest copy shows it.
//
// The LaunchAgent does not run this file where it is: the installer pins a
// copy of the few files it needs (PINNED_FILES, and the checkout's link to the
// Supabase project) under ~/Library/Application Support/Drafter/offsite and
// runs that (`--pin`). Switching branches, a half-finished edit or moving the
// checkout no longer changes, or stops, what runs at night; installing again
// refreshes the copy.
//
// It never decrypts anything, and never writes to Supabase.

import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isEnvelope } from '../netlify/functions/lib/backupcrypto.mjs'

/** How long a copy is kept, in days. */
export const KEEP_DAYS = 60
/** The LaunchAgent's label, and its file's name. */
export const LABEL = 'app.drafter.backup-offsite'
/** Where the snapshots are, as the CLI names a storage path. */
export const REMOTE = 'ss:///media/backups/'
/** Storage commands talk to the linked project, and some CLI versions call them experimental. */
const CLI_FLAGS = ['--experimental', '--linked']

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/+$/, '')
const SCRIPT = fileURLToPath(import.meta.url)
const DAY = 86_400_000
const ACCOUNT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SNAPSHOT = /^(\d{4}-\d{2}-\d{2})\.json$/
/** A copy, or iCloud's stand-in for one it moved off this Mac to save space. */
const COPY = /^(?:(\d{4}-\d{2}-\d{2})\.json|\.(\d{4}-\d{2}-\d{2})\.json\.icloud)$/

/** A copy older than this many days is a warning: the nightly backup, or this, has stopped reaching iCloud. */
export const STALE_DAYS = 3
/** While the copies stay stale, the warning comes back this often, not every night. */
export const WARN_EVERY_DAYS = 7
/** What the pinned copy holds, by its path in the checkout: this script and what it imports, and the file the CLI knows a project folder by. */
export const PINNED_FILES = ['scripts/backup-offsite.mjs', 'netlify/functions/lib/backupcrypto.mjs', 'supabase/config.toml']
/** Where `supabase link` keeps the checkout's link to the project; the CLI reads it from the folder it runs in. */
const LINK_DIR = join('supabase', '.temp')

/** Where everything goes by default, under `home`. */
export function defaultPaths(home = homedir()) {
  const cloud = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
  const support = join(home, 'Library', 'Application Support', 'Drafter')
  return {
    /** iCloud Drive itself: present only when it is turned on. */
    cloud,
    dest: join(cloud, 'Drafter Backups'),
    log: join(home, 'Library', 'Logs', 'drafter-backup-offsite.log'),
    /** The copy of this script the LaunchAgent runs (pinCopy). */
    pinned: join(support, 'offsite'),
    /** When the last "the newest copy is old" warning was shown. Beside the pinned copy, so installing again keeps it. */
    state: join(support, 'offsite-state.json'),
  }
}

/**
 * The real CLI: `supabase <args>` run in this checkout (where it finds the
 * linked project), resolving what it printed, or rejecting with the end of
 * what it said went wrong.
 */
export function supabaseCli({ bin = 'supabase', cwd = ROOT } = {}) {
  return args =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000 }, (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout))
        const said = String(stderr || err.message).trim().split('\n').slice(-3).join(' ')
        reject(new Error(`supabase ${args.slice(0, 2).join(' ')} failed: ${said.slice(0, 400)}`))
      })
    })
}

/**
 * The names a `supabase storage ls` printed, one a line, folders ending in
 * "/". A line that is a whole path is cut to its last part; anything else the
 * CLI prints is left for the filters to ignore.
 */
export function listedNames(stdout) {
  return String(stdout ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const folder = line.endsWith('/')
      const parts = line.replace(/\/+$/, '').split('/')
      return `${parts[parts.length - 1]}${folder ? '/' : ''}`
    })
}

/** The day `keepDays` before `now`: a copy dated before it goes. */
export function cutoffDay(now, keepDays = KEEP_DAYS) {
  return new Date(new Date(now).getTime() - keepDays * DAY).toISOString().slice(0, 10)
}

/** The names in an account's folder that are copies older than the cutoff. Nothing else in the folder is ever touched. */
export function copiesToPrune(names, now, keepDays = KEEP_DAYS) {
  const cutoff = cutoffDay(now, keepDays)
  return names.filter(name => {
    const m = COPY.exec(name)
    return !!m && (m[1] ?? m[2]) < cutoff
  })
}

async function exists(path) {
  return stat(path).then(
    () => true,
    () => false,
  )
}

/**
 * One pass: every account's encrypted snapshots of the last `keepDays` that
 * are not here yet, copied in; the old copies pruned. An account that fails
 * does not stop the others; its failure is in the result.
 */
export async function copyOffsite({ cli, dest, cloud = dirname(dest), tmp = tmpdir(), now = new Date(), keepDays = KEEP_DAYS }) {
  const result = { accounts: 0, copied: 0, present: 0, plain: 0, pruned: 0, failures: /** @type {string[]} */ ([]) }
  // never made here: a folder this script invented would sync to nowhere
  if (!(await exists(cloud))) throw new Error(`iCloud Drive is not on (there is no ${cloud}). Turn it on in System Settings → your name → iCloud → iCloud Drive.`)

  const accounts = listedNames(await cli(['storage', 'ls', ...CLI_FLAGS, REMOTE]))
    .filter(n => n.endsWith('/') && ACCOUNT.test(n.slice(0, -1)))
    .map(n => n.slice(0, -1))
  // silence is not success: a checkout linked to the wrong project lists nothing
  if (!accounts.length) throw new Error('found no backups under media/backups/ — is this checkout linked to the right project (supabase link)?')

  await mkdir(dest, { recursive: true })
  const cutoff = cutoffDay(now, keepDays)
  const work = await mkdtemp(join(tmp, 'drafter-offsite-'))
  try {
    for (const account of accounts) {
      result.accounts++
      try {
        const folder = join(dest, account)
        await mkdir(folder, { recursive: true })
        const here = new Set(await readdir(folder))
        // a copy an earlier run did not finish moving in
        for (const name of here) if (name.endsWith('.partial')) await rm(join(folder, name), { force: true })
        const snapshots = listedNames(await cli(['storage', 'ls', ...CLI_FLAGS, `${REMOTE}${account}/`])).filter(n => SNAPSHOT.test(n))
        for (const name of snapshots) {
          // older than the copies kept: fetching it would only prune it again
          if ((SNAPSHOT.exec(name)?.[1] ?? '') < cutoff) continue
          if (here.has(name) || here.has(`.${name}.icloud`)) {
            result.present++
            continue
          }
          const temp = join(work, `${account}-${name}`)
          await cli(['storage', 'cp', ...CLI_FLAGS, `${REMOTE}${account}/${name}`, temp])
          let body = null
          try {
            body = JSON.parse(await readFile(temp, 'utf8'))
          } catch {
            /* not JSON: not an envelope either */
          }
          if (!isEnvelope(body)) {
            // written before BACKUP_PASSPHRASE, or not a snapshot at all: never into iCloud
            result.plain++
            await rm(temp, { force: true })
            continue
          }
          const partial = join(folder, `${name}.partial`)
          await copyFile(temp, partial)
          await chmod(partial, 0o600)
          await rename(partial, join(folder, name))
          await rm(temp, { force: true })
          result.copied++
        }
      } catch (e) {
        result.failures.push(`${account}: ${e?.message ?? e}`)
      }
    }
    // every account folder here, including one the bucket no longer lists
    for (const account of (await readdir(dest)).filter(n => ACCOUNT.test(n))) {
      const folder = join(dest, account)
      try {
        for (const name of copiesToPrune(await readdir(folder), now, keepDays)) {
          await rm(join(folder, name), { force: true })
          result.pruned++
        }
      } catch (e) {
        result.failures.push(`pruning ${account}: ${e?.message ?? e}`)
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
  return result
}

/** The date of the newest copy among an account folder's names, or null. iCloud's stand-in counts: the copy exists. */
export function newestCopyDay(names) {
  let newest = null
  for (const name of names) {
    const m = COPY.exec(name)
    const day = m && (m[1] ?? m[2])
    if (day && (!newest || day > newest)) newest = day
  }
  return newest
}

/** The newest copy in any account's folder under `dest`, or null when there is none (or no folder). */
export async function newestCopyIn(dest) {
  let newest = null
  for (const account of (await readdir(dest).catch(() => [])).filter(n => ACCOUNT.test(n))) {
    const day = newestCopyDay(await readdir(join(dest, account)).catch(() => []))
    if (day && (!newest || day > newest)) newest = day
  }
  return newest
}

/**
 * Whether to warn that the copies here have gone stale: the newest is more
 * than STALE_DAYS old (or there is none), and no warning has been shown in
 * the last WARN_EVERY_DAYS. `ageDays` is null when there is no copy at all.
 */
export function staleCheck({ newest, now, lastWarnedAt = null }) {
  const today = new Date(now).toISOString().slice(0, 10)
  const ageDays = newest ? Math.round((Date.parse(today) - Date.parse(newest)) / DAY) : null
  const stale = ageDays === null || ageDays > STALE_DAYS
  const since = lastWarnedAt ? new Date(now).getTime() - new Date(lastWarnedAt).getTime() : Infinity
  return { stale, ageDays, warn: stale && !(since < WARN_EVERY_DAYS * DAY) }
}

/** What the warning says, in the notification and the log. */
export function staleMessage(newest, ageDays) {
  return newest ? `The newest off-site copy is ${ageDays} days old (${newest}).` : 'There is no off-site copy in iCloud Drive yet.'
}

/**
 * osascript's arguments for a notification. The words go in as arguments to
 * the script, never into its text, so nothing in a message (a quote, a
 * backslash) can change what the script does.
 */
export function notificationArgs(title, message) {
  const tidy = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
  return ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', tidy(title, 80), tidy(message, 240)]
}

/**
 * The real notifier: macOS's own, through osascript. It never throws — a
 * notification that cannot be shown must not fail the night — and does
 * nothing anywhere but a Mac.
 */
export function macNotifier({ bin = '/usr/bin/osascript', run = execFile, os = platform() } = {}) {
  return (title, message) =>
    new Promise(resolve => {
      if (os !== 'darwin') return resolve(false)
      run(bin, notificationArgs(title, message), { timeout: 15_000 }, err => resolve(!err))
    })
}

/**
 * Copy what the LaunchAgent runs into `to`, from the checkout at `from`:
 * PINNED_FILES, keeping their paths so the script's imports resolve, and the
 * checkout's link to the Supabase project, so the CLI run there finds the same
 * project. Built beside `to` and moved into place, so a run never finds half a
 * copy. Resolves what was copied and whether the link was among it.
 */
export async function pinCopy({ from = ROOT, to }) {
  await mkdir(dirname(to), { recursive: true })
  const next = await mkdtemp(join(dirname(to), `.${basename(to)}-`))
  try {
    const files = []
    for (const rel of PINNED_FILES) {
      await mkdir(dirname(join(next, rel)), { recursive: true })
      await copyFile(join(from, rel), join(next, rel))
      files.push(rel)
    }
    let linked = false
    for (const name of await readdir(join(from, LINK_DIR)).catch(() => [])) {
      if (!(await stat(join(from, LINK_DIR, name))).isFile()) continue
      await mkdir(join(next, LINK_DIR), { recursive: true })
      await copyFile(join(from, LINK_DIR, name), join(next, LINK_DIR, name))
      files.push(join(LINK_DIR, name))
      if (name === 'project-ref') linked = true
    }
    await rm(to, { recursive: true, force: true })
    await rename(next, to)
    return { files, linked }
  } catch (e) {
    await rm(next, { recursive: true, force: true })
    throw e
  }
}

/** The one line a run leaves in the log. */
export function logLine(now, result, error) {
  const at = new Date(now).toISOString()
  if (error) return `${at} FAILED: ${error}`
  const done = [`copied ${result.copied}`, `already here ${result.present}`, result.plain && `skipped ${result.plain} unencrypted`, result.pruned && `pruned ${result.pruned}`]
    .filter(Boolean)
    .join(', ')
  const failed = result.failures.length ? `; ${result.failures.join(' | ')}` : ''
  return `${at} ${result.failures.length ? 'FAILED' : 'ok'}: ${result.accounts} account(s): ${done}${failed}`
}

const xml = s =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/**
 * The LaunchAgent that runs this every night at `hour`:`minute` local time,
 * with the node, the CLI and this checkout named in full (launchd's own PATH
 * holds neither tool). Not at load: installing it runs nothing. What it says
 * on stderr — a node that cannot start, say — goes to the same log.
 */
export function launchAgentPlist({ node, supabase, script = SCRIPT, repo = ROOT, log = defaultPaths().log, hour = 3, minute = 30, label = LABEL }) {
  const path = [...new Set([dirname(node), dirname(supabase), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':')
  const args = [node, script, '--supabase', supabase]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(a => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(repo)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(path)}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${Number(hour)}</integer>
    <key>Minute</key>
    <integer>${Number(minute)}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`
}

const USAGE = `usage: node scripts/backup-offsite.mjs [--supabase <cli>] [--dest <folder>] [--log <file>] [--keep-days <n>]
       node scripts/backup-offsite.mjs --launch-agent --node <node> --supabase <cli>   (print the LaunchAgent)
       node scripts/backup-offsite.mjs --pin <folder>                                  (copy what the LaunchAgent runs there)`

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`)
      return v
    }
    if (flag === '--launch-agent') out.launchAgent = true
    else if (flag === '--node') out.node = value()
    else if (flag === '--supabase') out.supabase = value()
    else if (flag === '--dest') out.dest = value()
    else if (flag === '--log') out.log = value()
    else if (flag === '--keep-days') out.keepDays = Number(value())
    else if (flag === '--pin') out.pin = value()
    else if (flag === '--help' || flag === '-h') out.help = true
    else throw new Error(`unknown argument ${flag}`)
  }
  if (out.keepDays !== undefined && !(out.keepDays >= 1)) throw new Error('--keep-days must be a number of days, 1 or more')
  return out
}

/** When the last stale warning was shown, from the state file; null when never, or unreadable. */
async function readState(file) {
  try {
    const state = JSON.parse(await readFile(file, 'utf8'))
    return typeof state?.staleWarnedAt === 'string' ? state : { staleWarnedAt: null }
  } catch {
    return { staleWarnedAt: null }
  }
}

async function writeState(file, state) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(state)}\n`)
}

/**
 * The command line. Everything it touches can be handed in — the home folder,
 * the CLI, the clock, a temporary folder, the notifier — so a test runs it
 * whole against a fake. No notifier, no notification: only the LaunchAgent's
 * own run (the bottom of this file) hands in the real one. Resolves the exit code.
 */
export async function main(argv = process.argv.slice(2), { home = homedir(), cli = null, now = new Date(), tmp = tmpdir(), out = console, notify = null } = {}) {
  let args
  try {
    args = parseArgs(argv)
  } catch (e) {
    out.error(`backup-offsite: ${e.message}\n${USAGE}`)
    return 2
  }
  if (args.help) {
    out.log(USAGE)
    return 0
  }
  if (args.pin) {
    try {
      const { files, linked } = await pinCopy({ to: args.pin })
      out.log(`Pinned ${files.length} files into ${args.pin}:\n  ${files.join('\n  ')}`)
      if (!linked) out.log(`Warning: ${join(ROOT, LINK_DIR, 'project-ref')} is missing: run 'supabase link' in ${ROOT}, then install again, or every night will fail.`)
      return 0
    } catch (e) {
      out.error(`backup-offsite: could not pin a copy into ${args.pin}: ${e?.message ?? e}`)
      return 1
    }
  }
  if (args.launchAgent) {
    if (!args.node || !args.supabase) {
      out.error(`backup-offsite: --launch-agent needs --node and --supabase\n${USAGE}`)
      return 2
    }
    out.log(launchAgentPlist({ node: args.node, supabase: args.supabase, log: defaultPaths(home).log }).trimEnd())
    return 0
  }

  const paths = defaultPaths(home)
  const log = args.log ?? paths.log
  const dest = args.dest ?? paths.dest
  const lines = []
  let code
  let result = null
  let failure = null
  try {
    result = await copyOffsite({
      cli: cli ?? supabaseCli({ bin: args.supabase ?? 'supabase' }),
      dest,
      cloud: args.dest ? dirname(args.dest) : paths.cloud,
      tmp,
      now,
      keepDays: args.keepDays ?? KEEP_DAYS,
    })
    lines.push(logLine(now, result))
    code = result.failures.length ? 1 : 0
    if (code) failure = `${result.failures.length} of ${result.accounts} account(s) failed: ${result.failures[0]}`
  } catch (e) {
    lines.push(logLine(now, null, e?.message ?? e))
    failure = String(e?.message ?? e)
    code = 1
  }

  // A night that ran — whatever it copied — looks at the newest copy here. One
  // that could not run at all is its own notification.
  let staleWarning = null
  if (result) {
    const state = await readState(paths.state)
    const newest = await newestCopyIn(dest)
    const check = staleCheck({ newest, now, lastWarnedAt: state.staleWarnedAt })
    if (check.warn) {
      staleWarning = staleMessage(newest, check.ageDays)
      lines.push(`${new Date(now).toISOString()} STALE: ${staleWarning}`)
    }
    const staleWarnedAt = check.warn ? new Date(now).toISOString() : check.stale ? state.staleWarnedAt : null
    if (staleWarnedAt !== state.staleWarnedAt) await writeState(paths.state, { staleWarnedAt }).catch(e => out.error(`backup-offsite: could not write ${paths.state}: ${e?.message ?? e}`))
  }

  for (const line of lines) out.log(line)
  try {
    await mkdir(dirname(log), { recursive: true })
    await appendFile(log, lines.map(line => `${line}\n`).join(''))
  } catch (e) {
    out.error(`backup-offsite: could not write the log ${log}: ${e?.message ?? e}`)
    code = 1
  }
  if (notify) {
    if (failure) await notify('Drafter off-site backup failed', `${failure} — see ~/Library/Logs/drafter-backup-offsite.log`)
    if (staleWarning) await notify('Drafter off-site backup is behind', `${staleWarning} See ~/Library/Logs/drafter-backup-offsite.log.`)
  }
  return code
}

/** Run as a command rather than imported: by the path given or one that resolves to it (macOS's /var is /private/var). */
function runAsCommand() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === SCRIPT
  } catch {
    return false
  }
}

if (runAsCommand()) process.exitCode = await main(process.argv.slice(2), { notify: macNotifier() })
