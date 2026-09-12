import { useCallback, useReducer } from 'react'

/** One async action's state: whether it is running, and why it last failed ('' when it did not). */
export interface AsyncState {
  busy: boolean
  error: string
}

export type AsyncEvent = { type: 'start' } | { type: 'done' } | { type: 'error'; error: string } | { type: 'busy'; busy: boolean }

export function asyncReducer(state: AsyncState, event: AsyncEvent): AsyncState {
  switch (event.type) {
    case 'start':
      return { busy: true, error: '' }
    case 'done':
      return { ...state, busy: false }
    case 'error':
      return { ...state, error: event.error }
    case 'busy':
      return { ...state, busy: event.busy }
  }
}

/**
 * Perform `fn` as the action: clear the last error and show busy, keep a
 * failure's message, and end not busy either way. Never throws; resolves true
 * when `fn` succeeded.
 */
export async function runAction(dispatch: (event: AsyncEvent) => void, fn: () => Promise<unknown>): Promise<boolean> {
  dispatch({ type: 'start' })
  try {
    await fn()
    return true
  } catch (e) {
    dispatch({ type: 'error', error: (e as Error).message })
    return false
  } finally {
    dispatch({ type: 'done' })
  }
}

/**
 * `{ busy, error }` for one action, and `run()` to perform it: what each
 * Settings section used to keep as a pair of states. `setBusy` and `setError`
 * cover the steps that are not one plain run — a status fetch failing on open,
 * a sign-in that stays busy while the page is away at the provider.
 */
export function useAsyncAction(initialBusy: boolean | (() => boolean) = false) {
  const [state, dispatch] = useReducer(asyncReducer, initialBusy, busy => ({ busy: typeof busy === 'function' ? busy() : busy, error: '' }))
  const run = useCallback((fn: () => Promise<unknown>) => runAction(dispatch, fn), [])
  const setError = useCallback((error: string) => dispatch({ type: 'error', error }), [])
  const setBusy = useCallback((busy: boolean) => dispatch({ type: 'busy', busy }), [])
  return { busy: state.busy, error: state.error, run, setError, setBusy }
}
