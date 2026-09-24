import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { FullConfig } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import type { Stack } from './lane'
import { createMember, sql } from './stack'

// Before any test, once the build is served (Playwright starts webServer
// first): the stack answers, its database has every migration, Realtime
// carries a change, and the bundle the browsers will load talks to that stack
// and to no hosted project. Each failure says what to do, rather than
// surfacing later as a sign-in that hangs or a task that never arrives.

/** A hosted project's address, as a bundle built for one carries it. */
const HOSTED = /https?:\/\/[a-z0-9-]+\.supabase\.(?:co|in)\b/gi

/**
 * One change carried end to end, the way the app listens for it: an account
 * of its own signs in, subscribes, waits for the server to say the
 * subscription is on (src/realtime.ts waits for the same), and writes through
 * sync_posts. A fresh stack starts reading its write-ahead log on the first
 * subscription, and a test's ten seconds are no place to wait for that; a
 * Realtime that says nothing fails here, by name.
 */
async function realtimeCarries(stack: Stack): Promise<void> {
  const who = await createMember(stack, 'warmup')
  const sb = createClient(stack.url, stack.anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const signedIn = await sb.auth.signInWithPassword({ email: who.email, password: who.password })
  if (signedIn.error) throw new Error(`The local stack would not sign an account in: ${signedIn.error.message}`)
  const id = randomUUID()
  try {
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('Realtime delivered no change within a minute of a write: every live test would fail.')), 60_000)
      const finish = (error?: Error) => {
        clearTimeout(timer)
        if (error) fail(error)
        else done()
      }
      sb.channel('lane-warmup')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, change => {
          if ((change.new as { id?: unknown }).id === id) finish()
        })
        .on('system', {}, (news: { extension?: string; status?: string; message?: string }) => {
          if (news?.extension !== 'postgres_changes') return
          if (news.status !== 'ok') return finish(new Error(`Realtime would not listen to public.posts: ${news.message ?? news.status}`))
          const now = new Date().toISOString()
          const task = { kind: 'task', id, title: 'Realtime warm-up', status: 'todo', priority: 'normal', tags: [], createdAt: now, updatedAt: now }
          void sb.rpc('sync_posts', { incoming: [task], since: null }).then(({ error }) => error && finish(new Error(`sync_posts: ${error.message}`)))
        })
        .subscribe((status, error) => {
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') finish(new Error(`Realtime would not open a channel (${status}${error ? `: ${error.message}` : ''})`))
        })
    })
  } finally {
    await sb.removeAllChannels()
    await sb.auth.signOut()
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const stack = config.projects[0]?.use as { stack?: Stack | null } | undefined
  if (!stack?.stack) return
  const { url, anonKey } = stack.stack
  // the repository, wherever Playwright was started from
  const root = config.configFile ? dirname(config.configFile) : process.cwd()

  const health = await fetch(`${url}/auth/v1/health`, { headers: { apikey: anonKey } }).catch((e: Error) => e)
  if (health instanceof Error || !health.ok) {
    throw new Error(`The local stack at ${url} does not answer (${health instanceof Error ? health.message : health.status}): is \`supabase start\` done?`)
  }

  // every migration in the repository, applied by `supabase start` (or reset)
  const files = readdirSync(resolve(root, 'supabase/migrations'))
    .filter(f => f.endsWith('.sql'))
    .map(f => f.split('_')[0])
  const applied = new Set((await sql(stack.stack, 'select version from supabase_migrations.schema_migrations;')).split('\n').filter(Boolean))
  const missing = files.filter(v => !applied.has(v))
  if (missing.length) throw new Error(`The local stack lacks ${missing.length} migration(s), ${missing.join(', ')}: \`supabase db reset\` applies them all to a local stack.`)
  const live = await sql(stack.stack, "select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'posts';")
  if (live !== '1') throw new Error('public.posts is not in the supabase_realtime publication (20261007000000_v3_30_realtime.sql): Realtime would say nothing.')
  await realtimeCarries(stack.stack)

  // the bundle: this stack's address and key in it, and no hosted project's
  const bundle = (config.metadata as { bundle?: string }).bundle
  if (!bundle) throw new Error('playwright.cloud.config.ts names no bundle to check (metadata.bundle)')
  const assets = resolve(root, bundle, 'assets')
  const scripts = readdirSync(assets)
    .filter(f => f.endsWith('.js'))
    .map(f => readFileSync(join(assets, f), 'utf8'))
  const hosted = [...new Set(scripts.flatMap(s => s.match(HOSTED) ?? []))]
  if (hosted.length) throw new Error(`The cloud build points at ${hosted.join(', ')}, not the local stack. Nothing was run.`)
  if (!scripts.some(s => s.includes(JSON.stringify(url)) || s.includes(`'${url}'`) || s.includes(`\`${url}\``))) {
    throw new Error(`The cloud build does not carry ${url}: it would not sign in to the local stack. Nothing was run.`)
  }
  if (!scripts.some(s => s.includes(anonKey))) throw new Error('The cloud build does not carry the local stack’s anon key. Nothing was run.')
}
