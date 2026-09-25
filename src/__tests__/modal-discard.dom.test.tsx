// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from './dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FIELD_SETTLE_MS, Modal, ModalCancel, ModalHead, useDiscardPrompt } from '../components/Modal'

// The sheet's ways out, pressed as a person would. A tap above a sheet while
// a field in it is up — the keyboard, an iPhone's date wheel — puts that away
// and leaves the sheet; the tap that has just done so is not a close either.
// A sheet with unsaved changes asks "Discard changes?" once, in the app, from
// every way out: the backdrop, Escape, ✕, Cancel and the swipe down.

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.documentElement.classList.remove('native')
})

const backdrop = () => document.querySelector('.modal-backdrop') as HTMLElement
const prompt = () => screen.queryByRole('alertdialog', { name: 'Discard changes?' })

function Sheet({ onClose, dirty = false, compose = false }: { onClose(): void; dirty?: boolean; compose?: boolean }) {
  return (
    <Modal onClose={onClose} dirty={dirty}>
      <ModalHead title="Edit" variant={compose ? 'compose' : 'default'} />
      <div className="modal-body">
        <label>
          Name
          <input defaultValue="Dave" />
        </label>
        <input type="date" aria-label="Day" />
      </div>
      <footer className="modal-foot">
        <ModalCancel>Not now</ModalCancel>
      </footer>
    </Modal>
  )
}

describe('a tap above the sheet while a field is up', () => {
  it('puts the keyboard away and keeps the sheet', () => {
    const onClose = vi.fn()
    render(<Sheet onClose={onClose} />)
    const name = screen.getByRole('textbox', { name: 'Name' })
    name.focus()
    expect(document.activeElement).toBe(name)
    fireEvent.mouseDown(backdrop())
    expect(document.activeElement).not.toBe(name)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('ignores the tap that closed a date picker a moment after the field let go, and closes on the next one', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    render(<Sheet onClose={onClose} />)
    const day = screen.getByLabelText('Day')
    day.focus()
    // the wheel is dismissed: the field blurs first, then the tap lands on the backdrop
    act(() => day.blur())
    fireEvent.mouseDown(backdrop())
    expect(onClose).not.toHaveBeenCalled()
    vi.advanceTimersByTime(FIELD_SETTLE_MS + 50)
    fireEvent.mouseDown(backdrop())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes a sheet with nothing up at once', () => {
    const onClose = vi.fn()
    render(<Sheet onClose={onClose} />)
    fireEvent.mouseDown(backdrop())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('leaves a press that began inside the sheet alone', () => {
    const onClose = vi.fn()
    render(<Sheet onClose={onClose} />)
    fireEvent.mouseDown(screen.getByRole('textbox', { name: 'Name' }))
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('a sheet with unsaved changes', () => {
  it('asks from the backdrop, and Keep editing keeps it open', () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const onClose = vi.fn()
    render(<Sheet onClose={onClose} dirty />)
    fireEvent.mouseDown(backdrop())
    expect(prompt()).toBeTruthy()
    // in the app, never the browser's own
    expect(confirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(prompt()).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Edit' })).toBeTruthy()
  })

  it('asks from Escape, and Discard closes it once', () => {
    const onClose = vi.fn()
    render(<Sheet onClose={onClose} dirty />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Escape' })
    expect(prompt()).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('takes Escape on the question as Keep editing, not as a second close', () => {
    const onClose = vi.fn()
    render(<Sheet onClose={onClose} dirty />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(prompt()).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Keep editing' }), { key: 'Escape' })
    expect(prompt()).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('asks from ✕, from the compose sheet’s Cancel and from a Cancel in the footer', () => {
    const onClose = vi.fn()
    const { unmount } = render(<Sheet onClose={onClose} dirty />)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(prompt()).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(prompt()).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    unmount()
    render(<Sheet onClose={onClose} dirty compose />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(prompt()).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('asks from the swipe down on the phone', () => {
    document.documentElement.classList.add('native')
    vi.stubGlobal('requestAnimationFrame', () => 0)
    const onClose = vi.fn()
    render(<Sheet onClose={onClose} dirty compose />)
    const head = document.querySelector('.modal-head') as HTMLElement
    head.setPointerCapture = () => {}
    fireEvent.pointerDown(head, { button: 0, pointerType: 'touch', pointerId: 1, clientY: 100 })
    fireEvent.pointerMove(head, { pointerId: 1, clientY: 300 })
    fireEvent.pointerUp(head, { pointerId: 1, clientY: 300 })
    expect(prompt()).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes a sheet with nothing unsaved from every way out, with no question', () => {
    const onClose = vi.fn()
    render(<Sheet onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(prompt()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})

describe('the question for a step that is not a close', () => {
  function MoreOptions({ onMore }: { onMore(): void }) {
    const { ask, prompt: question } = useDiscardPrompt()
    return (
      <>
        <button type="button" onClick={() => ask(onMore)}>
          More options
        </button>
        {question}
      </>
    )
  }

  it('runs the step on Discard, and nothing on Keep editing', () => {
    const onMore = vi.fn()
    render(<MoreOptions onMore={onMore} />)
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(onMore).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onMore).toHaveBeenCalledTimes(1)
    expect(prompt()).toBeNull()
  })
})
