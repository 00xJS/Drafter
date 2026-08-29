// Drafter sync + AI server.
//
//   npm run server                        — sync only
//   ANTHROPIC_API_KEY=sk-… npm run server — sync + AI proxy (keeps the key server-side)
//
// Stores posts in SQLite (node:sqlite, built into Node 22.5+) with last-write-wins
// merge by updatedAt, and serves the production build from ../dist when present.

import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'

const PORT = Number(process.env.PORT ?? 5174)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(__dirname, '..', 'dist')

const db = new DatabaseSync(path.join(__dirname, 'drafter.db'))
db.exec('CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, data TEXT NOT NULL)')
const upsertStmt = db.prepare(
  `INSERT INTO posts (id, updated_at, data) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data
   WHERE excluded.updated_at > posts.updated_at`,
)
const allStmt = db.prepare('SELECT data FROM posts')

// ANTHROPIC_WORKSPACE_ID: needed for identity-linked keys without a workspace scope
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic(
      process.env.ANTHROPIC_WORKSPACE_ID
        ? { defaultHeaders: { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } }
        : {},
    )
  : null
const AI_MODEL = 'claude-opus-5'

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}

function readBody(req, limitBytes = 200 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
}

async function serveStatic(req, res) {
  const urlPath = new URL(req.url, 'http://localhost').pathname
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '')
  let file = path.join(DIST, safe)
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end()
    return
  }
  try {
    let data
    try {
      data = await readFile(file)
    } catch {
      file = path.join(DIST, 'index.html') // SPA fallback
      data = await readFile(file)
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('Not found — run `npm run build` to serve the app from this server, or use `npm run dev`.')
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/health') {
      return json(res, 200, { ok: true, ai: anthropic !== null })
    }

    if (req.method === 'POST' && req.url === '/api/sync') {
      const body = JSON.parse(await readBody(req))
      const incoming = Array.isArray(body?.posts) ? body.posts : []
      let accepted = 0
      for (const p of incoming) {
        if (p && typeof p === 'object' && typeof p.id === 'string' && typeof p.updatedAt === 'string') {
          upsertStmt.run(p.id, p.updatedAt, JSON.stringify(p))
          accepted++
        }
      }
      const posts = allStmt.all().map(row => JSON.parse(row.data))
      return json(res, 200, { posts, accepted })
    }

    if (req.method === 'POST' && req.url === '/api/ai') {
      if (!anthropic) return json(res, 501, { error: 'ANTHROPIC_API_KEY is not set on the server' })
      const body = JSON.parse(await readBody(req, 1024 * 1024))
      const system = typeof body?.system === 'string' ? body.system : ''
      const prompt = typeof body?.prompt === 'string' ? body.prompt : ''
      if (!prompt) return json(res, 400, { error: 'prompt is required' })
      const maxTokens = Math.min(Math.max(Number(body?.maxTokens) || 2048, 256), 8192)
      const response = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
      })
      if (response.stop_reason === 'refusal') return json(res, 200, { text: '' })
      const text = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      return json(res, 200, { text })
    }

    if (req.method === 'GET') return serveStatic(req, res)
    res.writeHead(404)
    res.end()
  } catch (e) {
    console.error(e)
    json(res, 500, { error: String(e?.message ?? e) })
  }
})

server.listen(PORT, () => {
  console.log(`Drafter server on http://localhost:${PORT} (sync: on, AI proxy: ${anthropic ? 'on' : 'off — set ANTHROPIC_API_KEY'})`)
})
