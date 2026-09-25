/**
 * PostgREST answering one page of a paged read (restAll, in
 * netlify/functions/lib/backup.mjs): the rows after the id the read carried on
 * from (`id=gt.`), in id order, no more than the `limit` it asked for, and no
 * more than `maxRows`, PostgREST's own cap (1000 on Supabase). The read's
 * other filters are left to the code under test, as these fakes always left
 * them. `path` is the request's, from its /rest/v1/ on or after it.
 */
export function pageOf<T extends { id: string }>(path: string, rows: readonly T[], maxRows = 1000): T[] {
  const q = new URL(`https://x/${path.replace(/^\//, '')}`).searchParams
  const after = q.get('id')?.replace(/^gt\./, '') ?? null
  const limit = Number(q.get('limit') ?? maxRows)
  return rows
    .filter(r => after === null || r.id > after)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .slice(0, Math.min(limit, maxRows))
}

/** That page, as the response PostgREST sends. */
export const pageResponse = <T extends { id: string }>(path: string, rows: readonly T[], maxRows?: number): Response => Response.json(pageOf(path, rows, maxRows))
