import { describe, expect, it } from 'vitest'
import { AsyncEvent, AsyncState, asyncReducer, runAction } from '../components/settings/useAsyncAction'

/*
 * useAsyncAction replaced six busy/error pairs in Settings. What each pair did
 * by hand, in the same order every time: clear the last error and show busy,
 * keep a failure's message, end not busy — and never let the failure escape.
 */

const idle: AsyncState = { busy: false, error: '' }

describe('useAsyncAction: one busy flag and one error per action', () => {
  it('starting clears the last error and shows busy', () => {
    expect(asyncReducer({ busy: false, error: 'Offline' }, { type: 'start' })).toEqual({ busy: true, error: '' })
  })

  it('keeps a failure message after busy clears', () => {
    const events: AsyncEvent[] = [{ type: 'start' }, { type: 'error', error: 'Refused' }, { type: 'done' }]
    expect(events.reduce(asyncReducer, idle)).toEqual({ busy: false, error: 'Refused' })
  })

  it('lets busy and the error be set on their own', () => {
    expect(asyncReducer(idle, { type: 'busy', busy: true })).toEqual({ busy: true, error: '' })
    expect(asyncReducer({ busy: true, error: '' }, { type: 'error', error: 'Could not connect' })).toEqual({ busy: true, error: 'Could not connect' })
    expect(asyncReducer({ busy: true, error: 'x' }, { type: 'busy', busy: false })).toEqual({ busy: false, error: 'x' })
  })

  it('run: success is start then done, and resolves true', async () => {
    const seen: AsyncEvent[] = []
    await expect(runAction(e => seen.push(e), async () => {})).resolves.toBe(true)
    expect(seen).toEqual([{ type: 'start' }, { type: 'done' }])
  })

  it('run: a failure is recorded, never thrown, and resolves false', async () => {
    const seen: AsyncEvent[] = []
    await expect(
      runAction(
        e => seen.push(e),
        async () => {
          throw new Error('The server refused')
        },
      ),
    ).resolves.toBe(false)
    expect(seen).toEqual([{ type: 'start' }, { type: 'error', error: 'The server refused' }, { type: 'done' }])
    expect(seen.reduce(asyncReducer, { busy: false, error: 'an older one' })).toEqual({ busy: false, error: 'The server refused' })
  })
})
