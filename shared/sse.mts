// Server-sent events, read and written. NVIDIA streams a completion as an
// event stream (`data:` lines, and `data: [DONE]` at the end), and /api/ai
// streams the assistant's answer on to the app the same way, so one reader
// serves both: the server reads NVIDIA with it (netlify/functions/lib/ai.mjs)
// and the app reads the server (src/ai.ts).

/** One event: its name ('message' when the stream gave none) and its data, the lines of a multi-line field joined with \n. */
export interface SseEvent {
  event: string
  data: string
}

/**
 * A reader for an event stream, fed its text in whatever pieces the network
 * cut it into: a piece can end mid-line, mid-event, or between the \r and the
 * \n of one line break. `push` answers the events the text completed. `end`
 * answers an event the stream stopped inside: the standard drops it, but a
 * server that leaves off the last blank line should still have its last word
 * read. Comments (a line starting with a colon, often a keep-alive), `id` and
 * `retry` are skipped: nothing here reconnects.
 */
export function sseReader(): { push(text: string): SseEvent[]; end(): SseEvent[] } {
  let buffer = ''
  let started = false
  // the last piece ended on a \r: a \n starting the next is the same line break
  let afterCR = false
  let name = ''
  let data: string[] = []
  const out: SseEvent[] = []

  const dispatch = () => {
    if (data.length) out.push({ event: name || 'message', data: data.join('\n') })
    name = ''
    data = []
  }
  const line = (l: string) => {
    if (l === '') return dispatch()
    if (l.startsWith(':')) return
    const colon = l.indexOf(':')
    const field = colon < 0 ? l : l.slice(0, colon)
    let value = colon < 0 ? '' : l.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    else if (field === 'event') name = value
  }

  return {
    push(text) {
      if (!text) return []
      let t = text
      if (!started) {
        started = true
        if (t.startsWith('\uFEFF')) t = t.slice(1)
      }
      if (afterCR && t.startsWith('\n')) t = t.slice(1)
      afterCR = false
      buffer += t
      let from = 0
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i]
        if (ch !== '\r' && ch !== '\n') continue
        line(buffer.slice(from, i))
        if (ch === '\r') {
          if (i + 1 === buffer.length) afterCR = true
          else if (buffer[i + 1] === '\n') i++
        }
        from = i + 1
      }
      buffer = buffer.slice(from)
      return out.splice(0)
    },
    end() {
      if (buffer) line(buffer)
      buffer = ''
      dispatch()
      return out.splice(0)
    },
  }
}

/** One event as it goes on the wire: a name, and its data as one line of JSON (which never holds a raw line break). */
export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}
