/**
 * Dictation, from the browser's own recogniser.
 *
 * The palette already turns a typed line into a task — parseCapture reads the
 * date, the people and the tags out of it and the editor opens for you to
 * confirm. Speaking a line is the same road with a different first step, so
 * this deliberately does no parsing and no AI of its own: it puts words in the
 * field and everything after that is the path a typed line already takes.
 *
 * It costs nothing and sends nothing of ours anywhere. The Web Speech API is
 * the browser's, and where it is missing this reports so rather than reaching
 * for a service: on the iPhone the keyboard's own 🎤 key already dictates into
 * any field, which is why there is no plugin here and no microphone permission
 * in the iOS shell.
 */

import { isNative } from './native'

type Recogniser = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechEvent) => void) | null
  onerror: ((e: { error?: string }) => void) | null
  onend: (() => void) | null
}
type SpeechEvent = { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }
type Ctor = new () => Recogniser

/**
 * Safari and Chrome ship it prefixed; Firefox ships nothing. Never inside the
 * iOS shell, whatever the web view exposes: the app declares no microphone or
 * speech-recognition use to iOS (Info.plist has no usage description for
 * either), so a recogniser started there could only be refused.
 */
function ctor(): Ctor | null {
  if (isNative()) return null
  const w = globalThis as { SpeechRecognition?: Ctor; webkitSpeechRecognition?: Ctor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/**
 * Whether to offer the microphone at all. False inside the iOS shell, where
 * the keyboard's own dictation key is the answer — a button that asked and
 * then failed would be worse than no button.
 */
export function speechAvailable(): boolean {
  return !!ctor()
}

export type Listening = {
  /** Finish and keep what was heard. */
  stop(): void
  /** Give up and keep nothing. */
  cancel(): void
}

export type Heard = {
  /** Everything settled so far, plus whatever is still being guessed at. */
  onText(text: string, settled: boolean): void
  /** The recogniser closed, for any reason including stop(). */
  onEnd(): void
  /** A message worth showing, already in plain words. */
  onError(message: string): void
}

/**
 * Start listening. Interim results are reported as they come so the field
 * fills while you speak; `settled` marks the words the recogniser has stopped
 * revising. Returns null when there is nothing to listen with.
 */
export function listen({ onText, onEnd, onError }: Heard): Listening | null {
  const C = ctor()
  if (!C) return null
  let rec: Recogniser
  try {
    rec = new C()
  } catch {
    return null
  }
  rec.lang = typeof navigator === 'undefined' ? 'en-US' : navigator.language || 'en-US'
  // one utterance at a time: a captured line is a sentence, and leaving the
  // microphone open past it is both a surprise and a battery cost
  rec.continuous = false
  rec.interimResults = true

  let settledText = ''
  let done = false
  const finish = () => {
    if (done) return
    done = true
    onEnd()
  }

  rec.onresult = e => {
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const alt = e.results[i][0]
      if (!alt) continue
      if (e.results[i].isFinal) settledText += alt.transcript
      else interim += alt.transcript
    }
    // trimmed at both ends: settledText keeps its own spacing, so this only
    // tidies what is shown
    const all = (settledText + interim).replace(/\s+/g, ' ').trim()
    if (all) onText(all, !interim)
  }
  rec.onerror = e => {
    // `aborted` is what cancel() raises and `no-speech` is a quiet room;
    // neither is worth a message, and the rest are said plainly
    const kind = e?.error ?? ''
    if (kind === 'aborted' || kind === 'no-speech') return
    onError(
      kind === 'not-allowed' || kind === 'service-not-allowed'
        ? 'Dictation needs permission to use the microphone.'
        : kind === 'network'
          ? 'Dictation needs a connection.'
          : 'Dictation stopped.',
    )
  }
  rec.onend = finish

  try {
    rec.start()
  } catch {
    return null
  }
  return {
    stop: () => {
      try {
        rec.stop()
      } catch {
        finish()
      }
    },
    cancel: () => {
      try {
        rec.abort()
      } catch {
        finish()
      }
    },
  }
}
