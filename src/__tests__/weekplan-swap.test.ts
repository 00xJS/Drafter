import { describe, expect, it } from 'vitest'
import { nextSwap } from '../components/WeekPlanSheet'

// Two nights' alternatives can share a dish (proposeWeek hands each night a
// few of the same spares), so Swap skips whatever another ticked night has.

describe('Swap never gives a week one dish twice', () => {
  it('moves to the next choice in the night’s cycle, wrapping round', () => {
    expect(nextSwap(['a', 'b', 'c'], 0, new Set())).toBe(1)
    expect(nextSwap(['a', 'b', 'c'], 2, new Set())).toBe(0)
  })

  it('skips a dish another ticked night already has', () => {
    expect(nextSwap(['a', 'b', 'c'], 0, new Set(['b']))).toBe(2)
    expect(nextSwap(['a', 'b', 'c'], 1, new Set(['c']))).toBe(0)
  })

  it('has nowhere to go when every other choice is taken, or there is no other', () => {
    expect(nextSwap(['a', 'b'], 0, new Set(['b']))).toBeNull()
    expect(nextSwap(['a'], 0, new Set())).toBeNull()
  })
})
