import { afterEach, describe, expect, it, vi } from 'vitest'
import { listen, speechAvailable } from '../speech'

/*
 * Dictation in the palette. The point of the module is that it puts words in
 * the field and stops there — nothing it hears files a task, and a palette
 * closed mid-sentence must not leave the microphone open. Both of those, and
 * the shape the two browsers actually ship, are held here.
 */

type Handler = ((e: unknown) => void) | null
class FakeRecogniser {
  static last: FakeRecogniser | null = null
  static failToStart = false
  lang = ''
  continuous = true
  interimResults = false
  started = 0
  stopped = 0
  aborted = 0
  onresult: Handler = null
  onerror: Handler = null
  onend: (() => void) | null = null
  constructor() {
    FakeRecogniser.last = this
  }
  start() {
    if (FakeRecogniser.failToStart) throw new Error('already started')
    this.started++
  }
  stop() {
    this.stopped++
    this.onend?.()
  }
  abort() {
    this.aborted++
    this.onend?.()
  }
  /**
   * What the browser fires. `resultIndex` is the first result that CHANGED —
   * a settled one is never sent again, which is what lets the module add
   * finals up instead of replacing them.
   */
  say(parts: { text: string; final: boolean }[], resultIndex = 0) {
    const results = parts.map(p => Object.assign([{ transcript: p.text }], { isFinal: p.final }))
    this.onresult?.({ resultIndex, results })
  }
}

const g = globalThis as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }
function install(where: 'SpeechRecognition' | 'webkitSpeechRecognition' = 'webkitSpeechRecognition') {
  g[where] = FakeRecogniser
}

afterEach(() => {
  delete g.SpeechRecognition
  delete g.webkitSpeechRecognition
  FakeRecogniser.last = null
  FakeRecogniser.failToStart = false
})

describe('speechAvailable', () => {
  it('is false with no recogniser, which is the iPhone shell', () => {
    expect(speechAvailable()).toBe(false)
    expect(listen({ onText: vi.fn(), onEnd: vi.fn(), onError: vi.fn() })).toBeNull()
  })

  it('takes the prefixed constructor Safari and Chrome ship, as well as the plain one', () => {
    install('webkitSpeechRecognition')
    expect(speechAvailable()).toBe(true)
    delete g.webkitSpeechRecognition
    install('SpeechRecognition')
    expect(speechAvailable()).toBe(true)
  })
})

describe('listen', () => {
  it('asks for one utterance with interim results, so the field fills as you speak', () => {
    install()
    listen({ onText: vi.fn(), onEnd: vi.fn(), onError: vi.fn() })
    expect(FakeRecogniser.last?.continuous).toBe(false)
    expect(FakeRecogniser.last?.interimResults).toBe(true)
    expect(FakeRecogniser.last?.started).toBe(1)
  })

  it('revises the guess as you speak, then settles — one utterance, one result', () => {
    install()
    const onText = vi.fn()
    listen({ onText, onEnd: vi.fn(), onError: vi.fn() })
    const rec = FakeRecogniser.last!
    rec.say([{ text: 'call the dentist', final: false }])
    expect(onText).toHaveBeenLastCalledWith('call the dentist', false)
    rec.say([{ text: 'call the dentist tomorrow', final: false }])
    expect(onText).toHaveBeenLastCalledWith('call the dentist tomorrow', false)
    rec.say([{ text: 'call the dentist tomorrow', final: true }])
    expect(onText).toHaveBeenLastCalledWith('call the dentist tomorrow', true)
  })

  it('adds a settled segment to the ones before it rather than replacing them', () => {
    install()
    const onText = vi.fn()
    listen({ onText, onEnd: vi.fn(), onError: vi.fn() })
    const rec = FakeRecogniser.last!
    rec.say([{ text: 'call the dentist ', final: true }])
    expect(onText).toHaveBeenLastCalledWith('call the dentist', true)
    // the recogniser moves on: index 0 is settled and never sent again
    rec.say([{ text: 'call the dentist ', final: true }, { text: 'tomorrow', final: false }], 1)
    expect(onText).toHaveBeenLastCalledWith('call the dentist tomorrow', false)
  })

  it('ends once, whether it was stopped, cancelled or ran out on its own', () => {
    install()
    const onEnd = vi.fn()
    const session = listen({ onText: vi.fn(), onEnd, onError: vi.fn() })!
    session.stop()
    FakeRecogniser.last!.onend?.()
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(FakeRecogniser.last?.stopped).toBe(1)
  })

  it('cancel aborts, so a palette closed mid-sentence keeps nothing and frees the microphone', () => {
    install()
    const session = listen({ onText: vi.fn(), onEnd: vi.fn(), onError: vi.fn() })!
    session.cancel()
    expect(FakeRecogniser.last?.aborted).toBe(1)
    expect(FakeRecogniser.last?.stopped).toBe(0)
  })

  it('says nothing about a quiet room or its own abort, and says the rest plainly', () => {
    install()
    const onError = vi.fn()
    listen({ onText: vi.fn(), onEnd: vi.fn(), onError })
    for (const error of ['no-speech', 'aborted']) FakeRecogniser.last!.onerror?.({ error })
    expect(onError).not.toHaveBeenCalled()
    FakeRecogniser.last!.onerror?.({ error: 'not-allowed' })
    expect(onError).toHaveBeenLastCalledWith('Dictation needs permission to use the microphone.')
    FakeRecogniser.last!.onerror?.({ error: 'network' })
    expect(onError).toHaveBeenLastCalledWith('Dictation needs a connection.')
    FakeRecogniser.last!.onerror?.({ error: 'audio-capture' })
    expect(onError).toHaveBeenLastCalledWith('Dictation stopped.')
  })

  it('returns null when start throws, rather than a session that does nothing', () => {
    install()
    FakeRecogniser.failToStart = true
    expect(listen({ onText: vi.fn(), onEnd: vi.fn(), onError: vi.fn() })).toBeNull()
  })
})
