// Whether a line typed into the palette reads as a question. The palette
// (Search.tsx) asks it on every keystroke, and it is all it needs from Ask's
// retrieval (ask.ts, the assistant's code): it lives here so the palette's
// chunk, which the app warms at launch, does not carry the rest.

const QUESTION_START_RE = /^(?:who|what|when|where|why|how|did|have|do|is|was|which)\b/i

/** Whether the palette's "Ask Drafter" row should rank first for this query. */
export function looksLikeQuestion(q: string): boolean {
  const t = q.trim()
  return t.length > 1 && (t.endsWith('?') || QUESTION_START_RE.test(t))
}
