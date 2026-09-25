// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from './dom'
import { describe, expect, it } from 'vitest'
import { AccountSheet } from '../components/finance/AccountSheet'
import { CheckInSheet, type CheckInChange } from '../components/finance/CheckInSheet'
import { canBeOverdrawn, signedBalance } from '../finance'
import type { Account } from '../types'

// A balance is typed on the phone's decimal keypad, which has digits and a
// point and no minus: a checking account that had gone below zero could not
// be typed on an iPhone at all. Beside the accounts that can be overdrawn —
// checking, savings and cash — an Overdrawn toggle is the minus. A card's
// balance is what is owed on it, a positive number, and has none.

const TODAY = '2026-09-25'
const T0 = '2026-09-01T09:00:00.000Z'
const noop = () => {}
const account = (id: string, name: string, type: Account['type']): Account => ({ kind: 'account', id, name, type, balances: [{ on: '2026-09-20', amount: 400 }], createdAt: T0, updatedAt: T0 })
const CHECKING = account('a-chk', 'Chase Sapphire Preferred joint checking', 'checking')
const CARD = account('a-card', 'Chase Sapphire Preferred card', 'credit')

describe('a balance below zero, typed without a minus key', () => {
  it('reads the toggle as the minus, and a typed minus as it always did', () => {
    expect(signedBalance('80', true)).toBe(-80)
    expect(signedBalance('$1,234.50', true)).toBe(-1234.5)
    expect(signedBalance('80', false)).toBe(80)
    // a keyboard that has a minus still says overdrawn with it, pressed or not
    expect(signedBalance('-80', false)).toBe(-80)
    expect(signedBalance('(80)', true)).toBe(-80)
    expect(signedBalance('0', true)).toBe(0)
    expect(signedBalance('', true)).toBeNull()
    expect(signedBalance('lots', true)).toBeNull()
  })

  it('offers it for checking, savings and cash, never for a card or an investment', () => {
    expect((['checking', 'savings', 'cash'] as const).every(canBeOverdrawn)).toBe(true)
    expect(canBeOverdrawn('credit')).toBe(false)
    expect(canBeOverdrawn('investment')).toBe(false)
  })
})

describe('Check in', () => {
  it('saves a checking account overdrawn, and a card as owed, from the decimal keypad', () => {
    let saved: CheckInChange[] = []
    render(<CheckInSheet accounts={[CHECKING, CARD]} today={TODAY} onSave={c => (saved = c)} onClose={noop} />)
    const checking = screen.getByRole('textbox', { name: `${CHECKING.name}: balance today` })
    // the keypad stays the decimal one
    expect(checking.getAttribute('inputmode')).toBe('decimal')
    fireEvent.change(checking, { target: { value: '80.25' } })
    const toggle = screen.getByRole('button', { name: `${CHECKING.name}: Overdrawn` })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    // the card has no Overdrawn: what is owed on it is typed as it is
    expect(screen.queryByRole('button', { name: `${CARD.name}: Overdrawn` })).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: `${CARD.name}: owed today` }), { target: { value: '310' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }))
    const after = Object.fromEntries(saved.map(c => [c.after.id, c.after.balances.find(b => b.on === TODAY)?.amount]))
    expect(after).toEqual({ [CHECKING.id]: -80.25, [CARD.id]: 310 })
  })

  it('takes the toggle back off: pressed again, the amount is as typed', () => {
    let saved: CheckInChange[] = []
    render(<CheckInSheet accounts={[CHECKING]} today={TODAY} onSave={c => (saved = c)} onClose={noop} />)
    fireEvent.change(screen.getByRole('textbox', { name: `${CHECKING.name}: balance today` }), { target: { value: '80' } })
    const toggle = screen.getByRole('button', { name: `${CHECKING.name}: Overdrawn` })
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saved[0].after.balances.find(b => b.on === TODAY)?.amount).toBe(80)
  })
})

describe('an account’s sheet', () => {
  it('checks a checking account in overdrawn', () => {
    const calls: [Account | null, Account][] = []
    render(<AccountSheet account={CHECKING} members={[]} today={TODAY} onSave={(before, after) => calls.push([before, after])} onRemove={noop} onClose={noop} />)
    const field = screen.getByRole('textbox', { name: 'Balance today' })
    expect(field.getAttribute('inputmode')).toBe('decimal')
    fireEvent.change(field, { target: { value: '45' } })
    fireEvent.click(screen.getByRole('button', { name: `${CHECKING.name}: Overdrawn` }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls).toHaveLength(1)
    expect(calls[0][1].balances.find(b => b.on === TODAY)?.amount).toBe(-45)
  })

  it('has no Overdrawn on a card, whose balance is what is owed', () => {
    render(<AccountSheet account={CARD} members={[]} today={TODAY} onSave={noop} onRemove={noop} onClose={noop} />)
    expect(screen.getByRole('textbox', { name: 'Owed today' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Overdrawn/ })).toBeNull()
  })
})
