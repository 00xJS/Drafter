// One request's worth of mirror writes, inside the function's time limit.
//
// A function that runs past its limit is killed mid-loop and the client learns
// nothing about what got through, so a large re-mirror (turning a mirror on, a
// new Outlook account, a recreated Drafter calendar) timed out on every attempt
// and never finished. A batch now stops STARTING writes once its budget is
// spent and says exactly which records it did, which failed, and which it never
// reached; the client sends the rest in the next request.

/** Past this, start no new write: the lookups before the loop and the reply still need time. */
export const MIRROR_BUDGET_MS = 7_000
/** The most records one request will look at, whatever it is sent. */
export const MIRROR_MAX_RECORDS = 200

/** Provider statuses that fail every later write the same way, so the rest are not burned on them. */
export const isFatalStatus = status => status === 401 || status === 403 || status === 409

/**
 * Push records one at a time, in the order given.
 *
 * `done` lists what the provider accepted (created, updated, removed or had
 * nothing to do for), `errors` what it refused, and `left` what was never
 * attempted — past the budget, past `max`, or after a fatal refusal. The first
 * record is always attempted, so a slow lookup before the loop cannot turn
 * every request into no progress at all.
 */
export async function runMirrorBatch(records, push, opts = {}) {
  const now = opts.now ?? (() => Date.now())
  const startedAt = opts.startedAt ?? now()
  const budgetMs = opts.budgetMs ?? MIRROR_BUDGET_MS
  const max = opts.max ?? MIRROR_MAX_RECORDS
  const counts = { created: 0, updated: 0, removed: 0, skipped: 0 }
  const done = []
  const errors = []
  const left = []
  let fatal = false
  let attempted = 0
  for (const record of Array.isArray(records) ? records : []) {
    const id = typeof record?.id === 'string' ? record.id : ''
    if (!id) continue
    if (fatal || attempted >= max || (attempted > 0 && now() - startedAt >= budgetMs)) {
      left.push(id)
      continue
    }
    attempted++
    try {
      const result = await push(record)
      if (result in counts) counts[result]++
      done.push(id)
    } catch (e) {
      errors.push({ id, error: e?.message ?? String(e), ...(e?.status ? { status: e.status } : {}) })
      if (isFatalStatus(e?.status)) fatal = true
    }
  }
  return { ...counts, done, errors, left, fatal }
}

// ---- what a copy says, read back ------------------------------------------------
//
// Drafter writes the owner's notes into each copy with a footer of its own
// under them — for a task its project, its status and priority and a link back;
// for an entry just the link — and a task's title with its priority mark in
// front. The owner may rewrite either there. Reading them back strips exactly
// what Drafter added, in the order it added it, so a copy nobody touched reads
// back as the notes and title it was written from, and a pull cannot bounce.

const FOOTER_LINK = /^Open in Drafter:\s*\S+$/
const FOOTER_STATUS = /^Status: \S+\s*·\s*Priority: \S+$/
const FOOTER_PROJECT = /^Project: .+$/
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·' }
const HTML = /<(?:br|p|div|span|a|b|i|u|strong|em|ul|ol|li)\b[^>]*>|<\/(?:p|div|span|a|b|i|u|strong|em|ul|ol|li)>/i

/**
 * A copy's description as plain text. Google Calendar's own editor saves one
 * as HTML (`Bring the form<br><br>Open in Drafter: <a href=…>…</a>`), so a
 * note edited there comes back with its lines and list items, not its markup.
 */
export function copyText(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n')
  if (!HTML.test(s)) return s
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<\/(?:p|div|li|ul|ol|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
    })
}

/**
 * The owner's own notes in a copy's description: Drafter's footer taken off
 * the end. `task` for a task's footer (project, status and priority, link);
 * an entry's is the link alone. The project line is only ever taken with the
 * status line under it, so a note of the owner's that happens to end
 * "Project: …" stays theirs.
 */
export function ownNotes(text, opts = {}) {
  let out = copyText(text).replace(/[ \t]+$/gm, '').trimEnd()
  const strip = re => {
    const last = /(?:^|\n[ \t]*\n)([^\n]*)$/.exec(out)
    if (!last || !re.test(last[1].trim())) return false
    out = out.slice(0, last.index).trimEnd()
    return true
  }
  strip(FOOTER_LINK)
  if (opts.task && strip(FOOTER_STATUS)) strip(FOOTER_PROJECT)
  return out.trim()
}

/** A task copy's title without the priority mark Drafter puts in front (‼ urgent, ▲ high). */
export function ownTitle(summary) {
  return String(summary ?? '').replace(/^(?:‼|▲) /, '')
}
