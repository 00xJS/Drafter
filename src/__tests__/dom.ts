import { cleanup } from '@testing-library/react'
import { Storage } from 'happy-dom'
import { afterEach } from 'vitest'

/*
 * The DOM tests: a *.dom.test.tsx file whose first line is
 *
 *   // @vitest-environment happy-dom
 *
 * runs in a browser-like document (happy-dom) instead of bare node, so a
 * component mounts, runs its effects and answers real clicks, keys and
 * touches, where a server render only shows its first frame. Each imports
 * this file first: what it renders is taken down after every test, as vitest
 * does not do it on its own, and the storage is emptied.
 */

// Storage the code under test can use. vitest copies the document's globals
// over bare node's, but not one node already has, and Node 25 has a
// localStorage of its own, with no methods unless it is started with a file
// for it: a real one stands in, the same on every Node.
for (const key of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, key, { value: new Storage(), configurable: true, writable: true })
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
})

export { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
