import { useEffect, useMemo, useState } from 'react'
import { isMoney } from '../bills'
import { TIMELINE_DAYS, checkInDone, checkInTask, countable, nextSlot, openCheckIn } from '../finance'
import { localMidnightIso, newerStamp } from '../itemops'
import { OPEN_STATUSES, isIncomeKind, type Account, type Task } from '../types'
import { dateKey, uid } from '../utils'
import { noonOf, useDayKey } from '../useDayKey'
import { AccountSheet } from './finance/AccountSheet'
import { AddSheet } from './finance/AddSheet'
import { BillEditSheet, BillSheet } from './finance/BillSheet'
import { CheckInSheet, type CheckInChange } from './finance/CheckInSheet'
import { GoalSheet } from './finance/GoalSheet'
import { WEEKDAYS } from './finance/labels'
import { LineSheet } from './finance/LineSheet'
import { Manage, type ManageTab } from './finance/Manage'
import { PaydayEditSheet, PaydaySheet } from './finance/PaydaySheet'
import { Periods, type CheckInFocus } from './finance/Periods'

// Finance (v3.27): what Bills was, plus the two things it could not answer.
//
// Bills said what was due this month. It could not say whether there would be
// enough in the account before the 3rd, because nothing here knew what came IN
// or what the accounts held. A payday is a bill with the sign the other way
// round (bills.ts), and an account is a name and the balances you have typed.
//
// Drafter does not connect to a bank and never will. Everything below is
// arithmetic over what you wrote down, by one rule (finance.ts): the balance
// checked in is the truth on its day, and every bill, payday and set-aside
// dated after it counts, money in and out alike, each repeat every time it
// lands.
//
// It opens on the pay periods (finance/Periods.tsx): safe to spend, then each
// paycheck with what it has to cover before the next one lands and what is
// left when it does, then the accounts and the goals. One + adds a bill, a
// payday, a goal or a check-in. Manage (finance/Manage.tsx) holds the rest —
// the bills and paydays as lists, the month of bills, the accounts in their
// groups, the goals, an average month and the weekly check-in — as a screen
// you go into and come back from. A tap on any bill, payday or account opens
// its short sheet.

/**
 * The sheet over Finance, if any: the + and what it adds, Check in (on one
 * account, or adding one), a bill's or payday's short sheet by its task's id,
 * an account's (null to add one), and the cash line.
 */
type Sheet =
  | { kind: 'add' }
  | { kind: 'checkin'; focus?: CheckInFocus }
  | { kind: 'bill' }
  | { kind: 'payday' }
  | { kind: 'goal' }
  | { kind: 'money'; id: string }
  | { kind: 'account'; id: string | null }
  | { kind: 'line' }

const timeLabel = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(2026, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

interface Props {
  tasks: Task[]
  accounts: Account[]
  members: { id: string; displayName: string }[]
  /** The reader: the weekly check-in is each member's own. */
  myId?: string | null
  /** More than one member: a bill or a goal added here says who can see it. */
  inHousehold?: boolean
  /** The task editor, on a task as it is. */
  onOpen(t: Task): void
  /** The task editor on a bill or a payday with more to it than + Bill's or + Payday's short form. */
  onNew(preset: Partial<Task>): void
  onMarkPaid(t: Task): void
  /** A bill, a payday or a goal from Finance's own forms, or the weekly check-in turned on: written, with a toast and its Undo. */
  onAdd(t: Task, message: string): void
  /** A bill or payday edited in its short sheet, the weekly check-in moved to another day or time, or money with no date given one. */
  onSaveTask(t: Task): void
  /** The weekly check-in turned off: to the Trash, with an Undo. */
  onRemoveTask(t: Task): void
  /** A bill or payday deleted from its short sheet: to the Trash, with an Undo. */
  onDeleteTask(t: Task): void
  /** …or archived (cancelled: counted nowhere, and kept), or brought back, with an Undo. */
  onArchiveTask(t: Task, archive: boolean): void
  /** An account added, edited, archived or brought back from its sheet, with an Undo: `before` is null for one added. */
  onChangeAccount(before: Account | null, after: Account, message: string): void
  onRemoveAccount(id: string): void
  /** A Check in: every account written at once, and this week's check-in ticked off when it was due. */
  onCheckIn(changes: CheckInChange[], done: Task | null): void
  /** Open on Check in: handed over by the weekly check-in's task or its reminder. */
  checkIn?: boolean
  onCheckInOpened?(): void
  now?: Date
}

export function Finance(props: Props) {
  const { tasks, accounts, members, myId, inHousehold = false, onOpen, onNew, onMarkPaid, onAdd, onSaveTask, onRemoveTask, onDeleteTask, onArchiveTask, onChangeAccount, onRemoveAccount, onCheckIn, checkIn = false, onCheckInOpened, now } = props
  // Manage, when it is up, and the segment it is on: Finance opens on the
  // periods every time Tasks → Finance is picked
  const [manage, setManage] = useState<ManageTab | null>(null)
  const [days, setDays] = useState(TIMELINE_DAYS)
  // Check in, asked for from elsewhere — the weekly check-in's task, its
  // reminder — lands here with Finance not yet drawn, so it opens the sheet
  // from the first render, and again when it is asked while Finance is up
  const [sheet, setSheet] = useState<Sheet | null>(() => (checkIn ? { kind: 'checkin' } : null))
  const [asked, setAsked] = useState(checkIn)
  if (checkIn !== asked) {
    setAsked(checkIn)
    if (checkIn) setSheet({ kind: 'checkin' })
  }
  useEffect(() => {
    if (checkIn) onCheckInOpened?.()
  }, [checkIn, onCheckInOpened])

  // read by the day, so the forecast is not rebuilt on every render by a fresh
  // clock, and still starts from today once midnight has passed on a phone
  // left open here, as the bills beside it do (useDayKey)
  const dayKey = useDayKey()
  const at = useMemo(() => now ?? noonOf(dayKey), [now, dayKey])
  const today = now ? dateKey(now) : dayKey
  const live = useMemo(() => countable(accounts), [accounts])

  const close = () => setSheet(null)
  /**
   * A tap on a bill, payday or set-aside: its short sheet while it is open or
   * archived, the editor for one already done (a paid bill, a payday that
   * came in: what was paid is the editor's to say).
   */
  const openMoney = (t: Task) => {
    if (isMoney(t) && (OPEN_STATUSES.includes(t.status) || t.status === 'canceled')) setSheet({ kind: 'money', id: t.id })
    else onOpen(t)
  }
  /** Needs a date: the day typed in, as + Bill writes one (local midnight, a day with no time). */
  const dateMoney = (t: Task, day: string) => {
    const dueAt = localMidnightIso(day)
    if (dueAt) onSaveTask({ ...t, dueAt, updatedAt: newerStamp(t.updatedAt) })
  }

  /** Check in weekly: on at a slot, moved to another, or off. The slot is the open check-in's own due time. */
  const setWeekly = (slot: { weekday: number; time: string } | null) => {
    const current = openCheckIn(tasks, myId)
    if (!slot) {
      if (current) onRemoveTask(current)
      return
    }
    const next = nextSlot(new Date(), slot.weekday, slot.time)
    if (current) onSaveTask({ ...current, dueAt: next.toISOString(), updatedAt: newerStamp(current.updatedAt) })
    else onAdd(checkInTask(next, { id: uid(), now: new Date().toISOString() }), `Check in weekly: ${WEEKDAYS[slot.weekday]}s at ${timeLabel(slot.time)}`)
  }

  const moneyId = sheet?.kind === 'money' ? sheet.id : null
  const editing = moneyId ? tasks.filter(isMoney).find(t => t.id === moneyId) : undefined
  const account = sheet?.kind === 'account' && sheet.id ? accounts.find(a => a.id === sheet.id && !a.deletedAt) : undefined
  const edits = {
    inHousehold,
    myId,
    members,
    onClose: close,
    onSave: (t: Task) => {
      onSaveTask(t)
      close()
    },
    onArchive: (t: Task, archive: boolean) => {
      onArchiveTask(t, archive)
      close()
    },
    onDelete: (t: Task) => {
      onDeleteTask(t)
      close()
    },
    onEditor: (t: Task) => {
      close()
      onOpen(t)
    },
  }

  return (
    <div className="bills finance">
      {manage ? (
        <Manage
          tab={manage}
          onTab={setManage}
          tasks={tasks}
          accounts={accounts}
          members={members}
          myId={myId}
          today={today}
          at={at}
          onBack={() => setManage(null)}
          onOpen={openMoney}
          onOpenGoal={onOpen}
          onMarkPaid={onMarkPaid}
          onDate={dateMoney}
          onAddBill={() => setSheet({ kind: 'bill' })}
          onAddPayday={() => setSheet({ kind: 'payday' })}
          onAddGoal={() => setSheet({ kind: 'goal' })}
          onAddAccount={() => setSheet({ kind: 'account', id: null })}
          onAccount={id => setSheet({ kind: 'account', id })}
          onCheckIn={() => setSheet({ kind: 'checkin' })}
          onCheckInWeekly={setWeekly}
        />
      ) : (
        <Periods
          tasks={tasks}
          accounts={accounts}
          members={members}
          today={today}
          at={at}
          days={days}
          onDays={setDays}
          onManage={() => setManage('bills')}
          onAdd={() => setSheet({ kind: 'add' })}
          onOpen={openMoney}
          onOpenGoal={onOpen}
          onMarkPaid={onMarkPaid}
          onDate={dateMoney}
          onCheckIn={focus => setSheet({ kind: 'checkin', focus })}
          onAccount={id => setSheet({ kind: 'account', id })}
          onLine={() => setSheet({ kind: 'line' })}
        />
      )}

      {sheet?.kind === 'add' && <AddSheet onClose={close} onPick={choice => setSheet(choice === 'checkin' ? { kind: 'checkin' } : { kind: choice })} />}
      {sheet?.kind === 'checkin' && (
        <CheckInSheet
          accounts={live}
          focus={sheet.focus}
          today={today}
          onClose={close}
          onSave={changes => {
            onCheckIn(changes, checkInDone(tasks, myId, new Date()))
            close()
          }}
        />
      )}
      {sheet?.kind === 'bill' && (
        <BillSheet
          inHousehold={inHousehold}
          onClose={close}
          onMore={preset => {
            close()
            onNew(preset)
          }}
          onAdd={t => {
            onAdd(t, `Added “${t.title}”`)
            close()
          }}
        />
      )}
      {sheet?.kind === 'payday' && (
        <PaydaySheet
          members={members}
          myId={myId}
          inHousehold={inHousehold}
          onClose={close}
          onMore={preset => {
            close()
            onNew(preset)
          }}
          onAdd={t => {
            onAdd(t, `Added “${t.title}”`)
            close()
          }}
        />
      )}
      {sheet?.kind === 'goal' && (
        <GoalSheet
          today={today}
          at={at}
          inHousehold={inHousehold}
          onClose={close}
          onAdd={t => {
            onAdd(t, `Saving for “${t.title}”`)
            close()
          }}
        />
      )}
      {editing && (isIncomeKind(editing.bill.kind) ? <PaydayEditSheet key={editing.id} task={editing} {...edits} /> : <BillEditSheet key={editing.id} task={editing} {...edits} />)}
      {sheet?.kind === 'account' && (sheet.id === null || account) && (
        <AccountSheet
          key={sheet.id ?? 'new'}
          account={account}
          members={members}
          today={today}
          onClose={close}
          onSave={(before, after, message) => {
            onChangeAccount(before, after, message)
            close()
          }}
          onRemove={id => {
            onRemoveAccount(id)
            close()
          }}
        />
      )}
      {sheet?.kind === 'line' && <LineSheet accounts={accounts} tasks={tasks} at={at} onClose={close} />}
    </div>
  )
}
