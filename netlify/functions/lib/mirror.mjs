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
