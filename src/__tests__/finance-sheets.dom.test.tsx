// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from './dom'
import { describe, expect, it } from 'vitest'
import { Finance } from '../components/Finance'

// Finance's sheets load on their first tap, each from a chunk of its own,
// rather than with Finance: here, nothing has loaded them before the tap,
// and the sheet still opens, a moment after. (The Kitchen's two big sheets
// load the same way: kitchen-week.dom.test.tsx opens the week's plan on its
// first tap; lazyload.test.ts holds where each is loaded.)

const NOW = new Date(2026, 8, 23, 12, 0)
const noop = () => {}

describe('a sheet on its first tap', () => {
  it('Finance: Add to Finance opens its sheet, loaded then', async () => {
    const fns = { onOpen: noop, onNew: noop, onMarkPaid: noop, onAdd: noop, onSaveTask: noop, onRemoveTask: noop, onDeleteTask: noop, onArchiveTask: noop, onChangeAccount: noop, onRemoveAccount: noop, onCheckIn: noop }
    render(<Finance tasks={[]} accounts={[]} members={[]} myId="me" inHousehold={false} now={NOW} {...fns} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add to Finance' }))
    // loading a chunk is slower in a busy test run than on a phone: a generous wait
    const sheet = await screen.findByRole('dialog', { name: 'Add to Finance' }, { timeout: 5000 })
    // …and what it opens next loads the same way
    fireEvent.click(within(sheet).getByRole('button', { name: /^Goal/ }))
    expect(await screen.findByRole('dialog', { name: 'New goal' }, { timeout: 5000 })).toBeTruthy()
  })
})
