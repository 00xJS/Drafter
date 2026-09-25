// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from './dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// People, Places, the Stats views' day clock and the notes pad, as the React
// Compiler builds them (these tests run what it made of them): nothing kept
// from a clock read as they render, an ask taken once however often the
// parent hands a new setter, and the ✨ buttons freed whatever the assistant
// answered — the jobs the hand-written dependency lists and try/finally
// blocks did before, which kept the compiler off all four.

const ai = vi.hoisted(() => ({ suggestCatchUp: vi.fn(), suggestOuting: vi.fn() }))
vi.mock('../ai', () => ai)

import { People } from '../components/People'
import { Places } from '../components/Places'
import { EMIT_AFTER_MS, RichNotes } from '../components/RichNotes'
import { NO_PERSON_FILTER } from '../people'
import { NO_PLACE_FILTER } from '../places'
import { useDayClock } from '../useDayClock'
import type { Person, Place, Task } from '../types'

const STAMP = '2026-01-01T00:00:00.000Z'
/** A local time in September 2026. */
const sept = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute)

const mum: Person = { kind: 'person', id: 'mum', name: 'Mum', color: '#f97316', group: 'family', cadenceDays: 7, createdAt: STAMP, updatedAt: STAMP }
const dad: Person = { ...mum, id: 'dad', name: 'Dad', cadenceDays: undefined }
const nopi: Place = { kind: 'place', id: 'nopi', name: 'Nopi', category: 'restaurant', color: '#6366f1', createdAt: STAMP, updatedAt: STAMP }
const visit = (at: Date, over: Partial<Task> = {}): Task => ({
  kind: 'task',
  id: `v-${at.getTime()}`,
  title: 'Lunch',
  description: '',
  status: 'done',
  priority: 'normal',
  tags: ['visit'],
  peopleIds: ['mum'],
  completedAt: at.toISOString(),
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
})

const noop = () => {}
const peopleProps = { people: [mum, dad], tasks: [] as Task[], filter: NO_PERSON_FILTER, onFilter: noop, onSave: noop, onDelete: noop, onLogVisit: noop, onPlan: noop, onOpenTask: noop }
const placesProps = { places: [nopi], people: [mum], tasks: [] as Task[], meals: [], filter: NO_PLACE_FILTER, onFilter: noop, onSave: noop, onDelete: noop, onLogOuting: noop, onPlan: noop, onOpenTask: noop }

afterEach(() => {
  vi.useRealTimers()
  ai.suggestCatchUp.mockReset()
  ai.suggestOuting.mockReset()
})

describe('a list left open overnight', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('People counts the new day at midnight, not the morning it was opened', () => {
    // seen on the 14th, every 7 days: seven calendar days on the morning of the 21st
    vi.setSystemTime(sept(21, 8))
    render(<People {...peopleProps} tasks={[visit(sept(14, 10))]} />)
    expect(screen.getByText('Last seen 7 days ago')).toBeTruthy()
    // nothing changes but the time: past midnight she is eight days out, and due
    act(() => {
      vi.advanceTimersByTime(16 * 3_600_000 + 5_000)
    })
    expect(screen.getByText("It's been 8 days; you aimed for every 7 days")).toBeTruthy()
  })

  it('Places counts the new day at midnight too', () => {
    // a place with a weekly rhythm, last gone to at 10:00 on the 14th
    vi.setSystemTime(sept(22, 8))
    const outing = visit(sept(14, 10), { placeId: 'nopi', peopleIds: [] })
    render(<Places {...placesProps} places={[{ ...nopi, cadenceDays: 7 }]} tasks={[outing]} />)
    expect(screen.queryByText('Due a catch-up')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(16 * 3_600_000 + 5_000)
    })
    expect(screen.getByText('Due a catch-up')).toBeTruthy()
  })

  it("keeps one Stats clock all day, and starts the next day's at midnight", () => {
    vi.setSystemTime(sept(22, 21))
    const clocks: Date[] = []
    function Probe({ tick }: { tick: number }) {
      const now = useDayClock()
      clocks.push(now)
      return <p>{`${tick} ${now.getDate()}`}</p>
    }
    const { rerender } = render(<Probe tick={0} />)
    // a sync round, a keystroke: the same clock, so nothing memoised on it is worked out again
    rerender(<Probe tick={1} />)
    act(() => {
      vi.advanceTimersByTime(60 * 60_000)
    })
    rerender(<Probe tick={2} />)
    expect(new Set(clocks).size).toBe(1)
    expect(screen.getByText('2 22')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(2 * 3_600_000 + 5_000)
    })
    expect(clocks.at(-1)!.getDate()).toBe(23)
    expect(new Set(clocks).size).toBe(2)
  })

  it('uses a clock it is handed, as it is', () => {
    const handed = sept(1, 9)
    const seen: Date[] = []
    function Probe() {
      seen.push(useDayClock(handed))
      return null
    }
    render(<Probe />)
    expect(seen[0]).toBe(handed)
  })
})

describe('an ask from the shell', () => {
  it('opens the card asked for and tells the latest setter once per ask', () => {
    const first = vi.fn()
    const { rerender } = render(<People {...peopleProps} openId="mum" onOpenConsumed={first} />)
    expect(first).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /Mum/, expanded: true })).toBeTruthy()
    // the shell re-renders with a new setter and the same ask: no new ask
    const second = vi.fn()
    rerender(<People {...peopleProps} openId="mum" onOpenConsumed={second} />)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    // a new ask tells whichever setter is current
    rerender(<People {...peopleProps} openId="dad" onOpenConsumed={second} />)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('opens the add sheet asked for, once', () => {
    const added = vi.fn()
    const { rerender } = render(<Places {...placesProps} openAdd onAddConsumed={added} />)
    expect(added).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Add a place')).toBeTruthy()
    rerender(<Places {...placesProps} openAdd onAddConsumed={vi.fn()} />)
    expect(added).toHaveBeenCalledTimes(1)
  })
})

describe('the ✨ buttons', () => {
  it("say the assistant's failure on the row and free the button", async () => {
    ai.suggestCatchUp.mockRejectedValueOnce(new Error('The assistant is offline'))
    render(<People {...peopleProps} openId="mum" />)
    fireEvent.click(screen.getByRole('button', { name: '✨ Ideas' }))
    expect(screen.getByRole('button', { name: 'Thinking…' }).hasAttribute('disabled')).toBe(true)
    expect(await screen.findByText('The assistant is offline')).toBeTruthy()
    expect(screen.getByRole('button', { name: '✨ Ideas' }).hasAttribute('disabled')).toBe(false)
  })

  it('show the ideas that come back, and free the button', async () => {
    ai.suggestCatchUp.mockResolvedValueOnce([{ title: 'Coffee on Sunday', why: 'You have not been out together lately' }])
    render(<People {...peopleProps} openId="mum" />)
    fireEvent.click(screen.getByRole('button', { name: '✨ Ideas' }))
    expect(await screen.findByText('Coffee on Sunday')).toBeTruthy()
    expect(screen.getByRole('button', { name: '✨ Ideas' }).hasAttribute('disabled')).toBe(false)
    expect(ai.suggestCatchUp).toHaveBeenCalledWith(expect.objectContaining({ name: 'Mum' }))
  })

  it("free Places' button too, with the failure said above the list", async () => {
    ai.suggestOuting.mockRejectedValueOnce(new Error('Too many requests'))
    render(<Places {...placesProps} />)
    fireEvent.click(screen.getByRole('button', { name: '✨ Where should we go?' }))
    expect(await screen.findByText('Too many requests')).toBeTruthy()
    expect(screen.getByRole('button', { name: '✨ Where should we go?' }).hasAttribute('disabled')).toBe(false)
  })
})

describe('the notes pad', () => {
  it('fills with the note it opened on, once, and takes a later one from elsewhere', () => {
    const onChange = vi.fn()
    const { container, rerender } = render(<RichNotes value="<p>Hello</p>" onChange={onChange} autoFocus />)
    const pad = container.querySelector('.notes-editable') as HTMLElement
    expect(pad.innerHTML).toBe('<p>Hello</p>')
    expect(document.activeElement).toBe(pad)
    // typed into: the parent hears it, a beat after the last key (notes-typing.dom.test.tsx)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    pad.innerHTML = '<p>Hello there</p>'
    fireEvent.input(pad)
    act(() => void vi.advanceTimersByTime(EMIT_AFTER_MS))
    vi.useRealTimers()
    expect(onChange).toHaveBeenLastCalledWith('<p>Hello there</p>')
    // a re-render with a new handler leaves what is being written alone
    rerender(<RichNotes value="<p>Hello there</p>" onChange={vi.fn()} autoFocus />)
    expect(pad.innerHTML).toBe('<p>Hello there</p>')
    // an edit from another device replaces it
    rerender(<RichNotes value="<p>From the phone</p>" onChange={vi.fn()} autoFocus />)
    expect(pad.innerHTML).toBe('<p>From the phone</p>')
  })
})
