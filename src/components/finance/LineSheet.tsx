import { useMemo, useState } from 'react'
import { TIMELINE_DAYS, cashLine, shortfallLine } from '../../finance'
import type { Account, Task } from '../../types'
import { Modal, ModalHead } from '../Modal'
import { Segmented } from '../stats/Segmented'
import { CashLineChart } from './CashLineChart'
import { dayLabel } from './labels'

// The cash line, a tap away under safe to spend: what can be spent, from
// today, down on each bill and set-aside and up on each payday, for 30 days
// or 60. The same forecast the pay periods are cut from (moneyForecast).

const SPANS = [
  { key: '30', label: '30 days' },
  { key: '60', label: '60 days' },
] as const

export function LineSheet({ accounts, tasks, at, onClose }: { accounts: Account[]; tasks: Task[]; at: Date; onClose(): void }) {
  const [span, setSpan] = useState<'30' | '60'>('30')
  const days = span === '60' ? 60 : TIMELINE_DAYS
  const line = useMemo(() => cashLine(accounts, tasks, days, at), [accounts, tasks, days, at])
  return (
    <Modal onClose={onClose} className="modal narrow fin-sheet fin-line-sheet">
      <ModalHead title={`Cash, next ${days} days`} />
      <div className="modal-body">
        <Segmented items={SPANS} value={span} onChange={k => setSpan(k)} label="How far the line looks" role="group" className="fin-span" />
        {line ? (
          <>
            <CashLineChart line={line} days={days} onToggle={() => setSpan(s => (s === '30' ? '60' : '30'))} />
            {line.short && <p className="warn fin-short">{shortfallLine(line.short, dayLabel)}</p>}
            <p className="field-hint fin-sheet-hint">Checking and cash after each day’s bills, paydays and set-asides, from the balance you checked in. Savings stays out of it.</p>
          </>
        ) : (
          <p className="field-hint fin-sheet-hint">Check in what your checking and cash hold, and the line starts from it.</p>
        )}
      </div>
    </Modal>
  )
}
