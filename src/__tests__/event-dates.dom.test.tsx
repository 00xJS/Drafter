// @vitest-environment happy-dom
import { fireEvent, render, screen } from './dom'
import { describe, expect, it, vi } from 'vitest'
import { EventEditor } from '../components/EventEditor'
import type { CalendarEntry } from '../types'

// An event's Starts and Ends, as a day field and a time field each. One
// date-and-time field could be left holding no value on an iPhone when only
// its date was picked; a day alone now saves as that day's local midnight.

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement
const typeInto = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } })

function open() {
  const onSave = vi.fn<(entries: CalendarEntry[]) => void>()
  render(<EventEditor defaultStartIso={new Date(2026, 8, 25, 10).toISOString()} people={[]} onSave={onSave} onClose={() => {}} />)
  typeInto(screen.getByRole('textbox', { name: 'Title' }), 'Dentist')
  return onSave
}

describe('an event’s Starts and Ends', () => {
  it('are a day and a time each, never one date-and-time field', () => {
    open()
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull()
    expect([field('Starts').type, field('Starts').value, field('Start time').type, field('Start time').value]).toEqual(['date', '2026-09-25', 'time', '10:00'])
    expect([field('Ends').value, field('End time').value]).toEqual(['2026-09-25', '11:00'])
  })

  it('saves a day with no time as that day, and an end with no time on it as an hour on', () => {
    const onSave = open()
    typeInto(field('Starts'), '2026-09-30')
    typeInto(field('Start time'), '')
    typeInto(field('End time'), '')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    const [saved] = onSave.mock.calls[0][0]
    expect(saved.start).toBe(new Date(2026, 8, 30).toISOString())
    expect(saved.end).toBe(new Date(2026, 8, 30, 1).toISOString())
  })

  it('moves the end’s day along with the start’s, keeping its time', () => {
    const onSave = open()
    typeInto(field('Starts'), '2026-09-28')
    expect([field('Ends').value, field('End time').value]).toEqual(['2026-09-28', '11:00'])
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const [saved] = onSave.mock.calls[0][0]
    expect([saved.start, saved.end]).toEqual([new Date(2026, 8, 28, 10).toISOString(), new Date(2026, 8, 28, 11).toISOString()])
  })

  it('says so when the end comes before the start, and saves nothing', () => {
    const onSave = open()
    typeInto(field('Ends'), '2026-09-24')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText('The end has to be after the start.')).toBeTruthy()
  })

  it('asks for the day it starts when there is none', () => {
    const onSave = open()
    typeInto(field('Starts'), '')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText('Pick the day it starts.')).toBeTruthy()
  })
})
