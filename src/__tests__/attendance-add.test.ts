import { describe, expect, it } from 'vitest'
import { attendeeFor } from '../components/AttendancePicker'
import type { Person } from '../types'

// "Who was there?" — the owner asked to add someone who isn't in People yet,
// straight from the event, as the task's People picker now allows.

const stamp = '2026-09-01T00:00:00.000Z'
const person = (id: string, name: string): Person => ({ kind: 'person', id, name, color: '#888', createdAt: stamp, updatedAt: stamp }) as Person
const make = (name: string) => person('new', name)

describe('attendeeFor', () => {
  const people = [person('mum', 'Mum'), person('sam', 'Sam Hill')]

  it('means someone already saved, whatever the case or spacing', () => {
    expect(attendeeFor('  mum ', people, make)).toEqual({ person: people[0], created: false })
    expect(attendeeFor('sam   hill', people, make)).toEqual({ person: people[1], created: false })
  })

  it('makes a new person for a name nobody has, tidied', () => {
    const hit = attendeeFor('  Aunt   Jo ', people, make)
    expect(hit?.created).toBe(true)
    expect(hit?.person.name).toBe('Aunt Jo')
  })

  it('does nothing for a blank name', () => {
    expect(attendeeFor('   ', people, make)).toBeNull()
  })
})
