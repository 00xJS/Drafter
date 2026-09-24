import { formatMoney, isMoney, isPayday, isSaving, savedSoFar } from './bills'
import { ACCOUNT_TYPE_META, OPEN_STATUSES, type Account, type BalanceCheck, type Bill, type RecurrenceFreq, type Task } from './types'
import { dateKey } from './utils'
import { CHECK_IN_PREFIX, isCheckIn, nextOccurrence, seriesRoot } from '../shared/domain.mts'
import { isOverdue } from '../shared/due.mts'
import { shiftDayKey } from '../shared/journal.mts'

// Money, beyond the month of bills (v3.27).
//
// Bills answered "what is due this month". It could not answer the question
// underneath it — is there enough in there before the 3rd — because nothing
// here knew what came IN or what the accounts held. Paydays are bills with the
// sign the other way round (bills.ts), and an account is a name and the
// balances you have typed in.
//
// Drafter never connects to a bank and never will. Every figure below is
// arithmetic over what you told it: a balance you typed, plus the paydays and
// bills you wrote down, forward from the day that balance was true. That is
// the same contract Cashflow Compass keeps, and the reason its numbers can be
// trusted — nothing here is guessing at your money.

/** An account's newest check-in, or null when none has been typed in. */
export function latestBalance(account: Account): BalanceCheck | null {
  return account.balances.length ? account.balances[account.balances.length - 1] : null
}

/** What it held on `day`, or the newest check-in before it. Null when nothing was typed in by then. */
export function balanceOn(account: Account, day: string): BalanceCheck | null {
  let found: BalanceCheck | null = null
  for (const b of account.balances) {
    if (b.on > day) break
    found = b
  }
  return found
}

/**
 * A balance written in, keeping one per day. `on` is a day key, so typing
 * today's figure again replaces today's rather than adding a second — which is
 * what you want, because the second one is a correction of the first.
 */
export function withBalance(account: Account, amount: number, on = dateKey(new Date())): Account {
  const rest = account.balances.filter(b => b.on !== on)
  return { ...account, balances: [...rest, { on, amount: Math.round(amount * 100) / 100 }].sort((a, b) => a.on.localeCompare(b.on)) }
}

/** A credit card's balance is money OWED, so it counts against you. */
export const isLiability = (a: Account): boolean => !!ACCOUNT_TYPE_META[a.type].liability
/** Money you could actually spend today: not a card, not an investment. */
export const isLiquid = (a: Account): boolean => a.type === 'checking' || a.type === 'savings' || a.type === 'cash'
/**
 * Money meant for spending: checking and cash. Savings is liquid but kept, so
 * safe to spend and the cash line leave it out (the owner's rule, 2026-09-23)
 * and the accounts total, `liquid`, still counts it.
 */
export const isSpendable = (a: Account): boolean => a.type === 'checking' || a.type === 'cash'

/** The accounts a total counts: live, not archived. */
export const countable = (accounts: readonly Account[]): Account[] => accounts.filter(a => !a.deletedAt && !a.archivedAt)

export interface MoneyTotals {
  /** Everything owned less everything owed. */
  net: number
  /** What you could spend today: checking, savings and cash. */
  liquid: number
  /** What is meant for spending: checking and cash, not savings (isSpendable). */
  spendable: number
  /** What is owed on cards. A positive number. */
  owed: number
  /** Accounts with no balance typed in yet: the figures above simply do not include them. */
  unknown: number
  /** The oldest of the check-ins the totals are built from — how stale the picture is. */
  asOf: string | null
  /** The same, over the spendable accounts alone: how stale `spendable` is. */
  spendableAsOf: string | null
}

/**
 * What the household has, from the newest check-in on each account.
 *
 * `asOf` is the OLDEST of those, not the newest, and deliberately: a total
 * built from one balance typed this morning and one from March is only as
 * good as March. The view says so rather than implying the whole picture is
 * fresh.
 */
export function moneyTotals(accounts: readonly Account[]): MoneyTotals {
  let net = 0
  let liquid = 0
  let spendable = 0
  let owed = 0
  let unknown = 0
  let asOf: string | null = null
  let spendableAsOf: string | null = null
  for (const a of countable(accounts)) {
    const b = latestBalance(a)
    if (!b) {
      unknown += 1
      continue
    }
    if (isLiability(a)) {
      owed += b.amount
      net -= b.amount
    } else {
      net += b.amount
      if (isLiquid(a)) liquid += b.amount
    }
    if (isSpendable(a)) {
      spendable += b.amount
      if (!spendableAsOf || b.on < spendableAsOf) spendableAsOf = b.on
    }
    if (!asOf || b.on < asOf) asOf = b.on
  }
  const round = (n: number) => Math.round(n * 100) / 100
  return { net: round(net), liquid: round(liquid), spendable: round(spendable), owed: round(owed), unknown, asOf, spendableAsOf }
}

/** One dated money movement the forecast counts: a payday in, a bill or a set-aside out. */
export interface MoneyDay {
  day: string
  /** Positive in, negative out. */
  change: number
  /** Running spendable balance (checking and cash) at the end of that day. */
  balance: number
  rows: { title: string; amount: number; income: boolean; saving?: boolean }[]
}

/**
 * One open bill, payday or set-aside with a date, as the timeline reads it:
 * Coming up lists them, and the runway, the cash line and "safe to spend" add
 * up the ones with an amount.
 */
export interface MoneyRow {
  task: Task & { bill: Bill }
  /** YYYY-MM-DD it counts on. One already overdue is owed NOW, so it lands on today. */
  day: string
  /** YYYY-MM-DD it was due. */
  due: string
  /** Its day is over and it is still open (shared/due.mts: a day is overdue once it has gone). */
  overdue: boolean
  income: boolean
  saving: boolean
  /** Undefined when no amount is written down: such a row is listed, and never counted. */
  amount?: number
}

const byTitle = (a: MoneyRow, b: MoneyRow) => (a.task.title || '').localeCompare(b.task.title || '') || a.task.id.localeCompare(b.task.id)

/**
 * Every open bill, payday and set-aside due up to `days` from `now`, overdue
 * ones first, then by day — money in before money out on the same day, the
 * order the runway nets them in.
 *
 * Open is to do, doing or blocked: one still on the Wishlist, or cancelled, is
 * not money anybody owes (the rule the Stats lens and the month of bills keep).
 */
export function moneyRows(tasks: readonly Task[], now: Date, days: number): MoneyRow[] {
  const start = dateKey(now)
  const end = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days))
  const out: MoneyRow[] = []
  for (const t of tasks) {
    if (!isMoney(t) || !t.dueAt || !OPEN_STATUSES.includes(t.status)) continue
    const due = dateKey(new Date(t.dueAt))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) continue
    // the one overdue rule (shared/due.mts): its day is over, whatever its time
    const overdue = isOverdue(t.dueAt, now)
    const day = overdue ? start : due
    if (day > end) continue
    const amount = t.estimateCost !== undefined && Number.isFinite(t.estimateCost) ? t.estimateCost : undefined
    out.push({ task: t, day, due, overdue, income: isPayday(t), saving: isSaving(t), amount })
  }
  return out.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.due.localeCompare(b.due) || Number(b.income) - Number(a.income) || byTitle(a, b))
}

/**
 * Spendable cash (checking and cash, not savings), day by day, from today to
 * `days` out.
 *
 * Built from what is already written down: every open bill, payday and
 * set-aside with a due date in the window, counted once, against the spendable
 * balance as it stands now. A set-aside goes OUT here: it is money moved to
 * where it will not be spent, which is exactly what this is about, even though
 * no figure calls it spending. It does not invent a repeat — a series has
 * exactly one open occurrence at a time (bills.ts), so a fortnightly wage shows
 * its next payment and not the three after it. That is a floor, not a
 * projection, and it is the honest one: it can only be better than it says.
 */
export function cashRunway(accounts: readonly Account[], tasks: readonly Task[], days = 60, now = new Date()): MoneyDay[] {
  const byDay = new Map<string, MoneyDay['rows']>()
  for (const r of moneyRows(tasks, now, days)) {
    if (r.amount === undefined) continue
    const rows = byDay.get(r.day) ?? []
    rows.push({ title: r.task.title || (r.income ? 'Payday' : r.saving ? 'Savings' : 'Bill'), amount: r.amount, income: r.income, ...(r.saving ? { saving: true } : {}) })
    byDay.set(r.day, rows)
  }
  let balance = moneyTotals(accounts).spendable
  const out: MoneyDay[] = []
  for (const day of [...byDay.keys()].sort()) {
    const rows = byDay.get(day)!
    const change = rows.reduce((n, r) => n + (r.income ? r.amount : -r.amount), 0)
    balance = Math.round((balance + change) * 100) / 100
    out.push({ day, change: Math.round(change * 100) / 100, balance, rows })
  }
  return out
}

/** The first day the runway goes below zero, and by how much. Null when it never does. */
export function firstShortfall(runway: readonly MoneyDay[]): { day: string; balance: number } | null {
  const hit = runway.find(d => d.balance < 0)
  return hit ? { day: hit.day, balance: hit.balance } : null
}

/** "Maria · every 2 weeks · $1,840" — one payday, as a row reads it. */
export function paydayLine(t: Task, nameOf: (id: string | undefined) => string | null): string {
  const who = nameOf(t.bill?.forMemberId)
  return [who, t.bill?.payee, t.estimateCost !== undefined ? formatMoney(t.estimateCost) : ''].filter(Boolean).join(' · ')
}

/** "On Fri, Oct 3 the money you can actually spend goes to −$310.00 — counting only what is written down." */
export function shortfallLine(short: { day: string; balance: number }, dayLabel: (day: string) => string): string {
  return `On ${dayLabel(short.day)} the money you can actually spend goes to ${formatMoney(short.balance)} — counting only what is written down.`
}

// ---- the timeline -------------------------------------------------------------
//
// Finance opens on one question: are we OK until payday? Everything below is
// the arithmetic behind that screen, pure, so the view only draws it. Money in
// and out still comes from the rows above (moneyRows), the balances from
// moneyTotals, and a series' progress from what its finished occurrences paid
// (bills.ts) — nothing here counts a thing a second way.

/** A payday this many days off or nearer is the one "safe to spend" runs to. */
export const PAYDAY_HORIZON_DAYS = 45
/** How far Coming up and the cash line look, and what "safe to spend" covers with no payday in sight. */
export const TIMELINE_DAYS = 30

const round = (n: number) => Math.round(n * 100) / 100

/** Whether any account meant for spending has a balance typed in: without one there is nothing to count from. */
export const hasSpendableBalance = (accounts: readonly Account[]): boolean => countable(accounts).some(a => isSpendable(a) && !!latestBalance(a))

export interface SafeToSpend {
  /** Spendable now, less every bill and set-aside that falls due before `through` ends. Null with no spendable balance typed in. */
  amount: number | null
  /** What checking and cash hold, as typed in (never savings). */
  spendable: number
  /** The oldest check-in on those accounts (moneyTotals): how stale the figure is. */
  asOf: string | null
  /** The payday it runs to: the first one after today, when it lands within PAYDAY_HORIZON_DAYS. */
  payday: MoneyRow | null
  /** The last day it counts, YYYY-MM-DD: the day before that payday, or TIMELINE_DAYS on. */
  through: string
  /** What came off it: how many bills, how many set-asides, and what they add up to. */
  bills: number
  setAsides: number
  owed: number
  /** Bills and set-asides in that span with no amount written down: listed, not counted. */
  unpriced: number
  /** Accounts nobody has typed a balance into: not in the figure at all. */
  unchecked: number
}

/**
 * Safe to spend until payday: what checking and cash hold (savings is kept,
 * not spent, so it stays out), less
 * every bill and set-aside that falls due before the next payday — overdue
 * ones too, since those are owed now. The payday is the first after today:
 * one due today, or late, is either in the balance you typed or not here yet,
 * and a floor adds neither. A bill due ON payday is left to that payday.
 *
 * With no payday within PAYDAY_HORIZON_DAYS it covers the next TIMELINE_DAYS
 * instead, the window Coming up and the cash line show.
 */
export function safeToSpend(accounts: readonly Account[], tasks: readonly Task[], now: Date): SafeToSpend {
  const today = dateKey(now)
  const totals = moneyTotals(accounts)
  const rows = moneyRows(tasks, now, PAYDAY_HORIZON_DAYS)
  let payday: MoneyRow | null = null
  for (const r of rows) if (r.income && r.day > today && (!payday || r.day < payday.day)) payday = r
  const through = payday ? shiftDayKey(payday.day, -1) : shiftDayKey(today, TIMELINE_DAYS)
  let owed = 0
  let bills = 0
  let setAsides = 0
  let unpriced = 0
  for (const r of rows) {
    if (r.income || r.day > through) continue
    if (r.amount === undefined) {
      unpriced += 1
      continue
    }
    owed += r.amount
    if (r.saving) setAsides += 1
    else bills += 1
  }
  return {
    amount: hasSpendableBalance(accounts) ? round(totals.spendable - owed) : null,
    spendable: totals.spendable,
    asOf: totals.spendableAsOf,
    payday,
    through,
    bills,
    setAsides,
    owed: round(owed),
    unpriced,
    unchecked: totals.unknown,
  }
}

/** "after 3 bills and a set-aside", "after 1 bill", "nothing due before then". */
export function afterLine(s: Pick<SafeToSpend, 'bills' | 'setAsides'>): string {
  const n = (count: number, one: string, many: string) => (count === 1 ? one : `${count} ${many}`)
  const parts = [s.bills ? n(s.bills, '1 bill', 'bills') : '', s.setAsides ? n(s.setAsides, 'a set-aside', 'set-asides') : ''].filter(Boolean)
  return parts.length ? `after ${parts.join(' and ')}` : 'nothing due before then'
}

/** The cash line: spendable now, then each day something falls due, as far as it looks. */
export interface CashLine {
  /** Today and the last day drawn, YYYY-MM-DD. */
  from: string
  to: string
  /** Spendable now, where the line starts. */
  start: number
  /** The end of each day something falls due (cashRunway). */
  days: MoneyDay[]
  /** The lowest the line goes, and the first day it gets there; today's balance when nothing takes it lower. */
  low: { day: string; balance: number }
  high: number
  /** The first day it goes under, in firstShortfall's words. */
  short: { day: string; balance: number } | null
}

/** The cash line for `days` ahead (30, or 60 at a tap), or null with no spendable balance to start it from. */
export function cashLine(accounts: readonly Account[], tasks: readonly Task[], days: number, now: Date): CashLine | null {
  if (!hasSpendableBalance(accounts)) return null
  const from = dateKey(now)
  const start = moneyTotals(accounts).spendable
  const run = cashRunway(accounts, tasks, days, now)
  let low = { day: from, balance: start }
  let high = start
  for (const d of run) {
    if (d.balance < low.balance) low = { day: d.day, balance: d.balance }
    if (d.balance > high) high = d.balance
  }
  return { from, to: shiftDayKey(from, days), start, days: run, low, high, short: firstShortfall(run) }
}

/** Bills, paydays and set-asides for Coming up: the next TIMELINE_DAYS, overdue ones first. */
export const comingUp = (tasks: readonly Task[], now: Date): MoneyRow[] => moneyRows(tasks, now, TIMELINE_DAYS)

/** Whole days from one day key to another: 0 the same day, 2 for a balance typed in the day before yesterday. */
export function daysBetween(from: string, to: string): number {
  const at = (key: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN
  }
  return Math.round((at(to) - at(from)) / 86_400_000)
}

/** A week: a check-in older than this is old enough to say so. */
export const STALE_DAYS = 7

/**
 * A typed balance, or null for one that is not a number. `$1,234.56`, `1234`
 * and `-80` (an overdrawn checking account) all read; so does `(80)`, the way
 * a bank statement writes it.
 */
export function parseBalance(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  const negative = /^\(.*\)$/.test(t) || /^-|^\$-|^−/.test(t)
  const n = Number(t.replace(/[^0-9.]/g, ''))
  if (!/\d/.test(t) || !Number.isFinite(n)) return null
  return round(negative ? -n : n)
}

// ---- goals --------------------------------------------------------------------

export type GoalStatus = 'reached' | 'on-track' | 'behind' | 'open'

/** A savings goal, as its card reads it: a set-aside series and what its finished occurrences paid in. */
export interface GoalView {
  /** The open occurrence: the one the next set-aside is, and whose goal is the goal. */
  task: Task & { bill: Bill }
  target: number
  by?: string
  /** What the finished set-asides of the series paid in, and how many there were. */
  saved: number
  count: number
  /** Each set-aside, and how often. */
  each?: number
  freq?: RecurrenceFreq
  /** YYYY-MM-DD of the next set-aside. */
  next?: string
  /** Set-asides still to come by `by`, the next one included. */
  left?: number
  /** Where it will be on `by` at this rate. */
  projected?: number
  /** What each set-aside would have to be to get there by `by`. */
  needed?: number
  /** Set-asides still to make at this amount, the next one included, to reach the target. */
  toGo?: number
  status: GoalStatus
  /** 0–100, of the target. */
  pct: number
}

/**
 * How many times a series falls due from its open occurrence up to and
 * including `by`: stepped with nextOccurrence, the rule the repeat itself
 * follows, so a monthly one due on the 31st lands where the real ones will.
 */
export function occurrencesUntil(task: Task, by: string, cap = 1000): number {
  if (!task.dueAt || dateKey(new Date(task.dueAt)) > by) return 0
  let n = 1
  let cur: Task = task
  for (let i = 0; i < cap && cur.recurrence; i++) {
    const next = nextOccurrence({ ...cur, status: 'done', completedAt: cur.dueAt }, () => '')
    if (!next?.dueAt || dateKey(new Date(next.dueAt)) > by) break
    n += 1
    cur = next
  }
  return n
}

/** Every savings goal with an open set-aside, soonest-due first. */
export function savingGoals(tasks: readonly Task[], now: Date): GoalView[] {
  const today = dateKey(now)
  const open = new Map<string, Task & { bill: Bill }>()
  for (const t of tasks) {
    if (!isSaving(t) || !t.bill.goal || !(t.bill.goal.target > 0) || !OPEN_STATUSES.includes(t.status)) continue
    // one card per series: two open copies (ticked off on two devices) are one goal
    const root = seriesRoot(t.id)
    const seen = open.get(root)
    if (!seen || (t.dueAt ?? '9999') < (seen.dueAt ?? '9999')) open.set(root, t)
  }
  const out: GoalView[] = []
  for (const task of open.values()) {
    const goal = task.bill.goal!
    const { saved, count } = savedSoFar(tasks, task)
    const each = task.estimateCost !== undefined && task.estimateCost > 0 ? task.estimateCost : undefined
    const next = task.dueAt ? dateKey(new Date(task.dueAt)) : undefined
    const view: GoalView = {
      task,
      target: goal.target,
      by: goal.by,
      saved,
      count,
      each,
      freq: task.recurrence?.freq,
      next,
      status: 'open',
      pct: Math.max(0, Math.min(100, Math.round((saved / goal.target) * 100))),
    }
    if (saved < goal.target && each) view.toGo = Math.ceil(round(goal.target - saved) / each)
    if (saved >= goal.target) view.status = 'reached'
    else if (goal.by) {
      const left = goal.by < today ? 0 : occurrencesUntil(task, goal.by)
      view.left = left
      view.projected = round(saved + left * (each ?? 0))
      if (left > 0) view.needed = Math.ceil(((goal.target - saved) / left) * 100) / 100
      view.status = view.projected >= goal.target ? 'on-track' : 'behind'
    }
    out.push(view)
  }
  return out.sort((a, b) => (a.next ?? '9999').localeCompare(b.next ?? '9999') || (a.task.title || '').localeCompare(b.task.title || ''))
}

// ---- the weekly check-in ------------------------------------------------------
//
// "Check in weekly" is a repeating task, not a setting of its own: a task is
// already on Home, in the reminders, on the Calendar and in the phone's own
// notifications, so the check-in is too with nothing new behind it. Its id
// starts CHECK_IN_PREFIX, which is how the app opens it on Finance's Check in
// sheet rather than in the editor, and how nextOccurrence keeps it on its
// slot — a check-in done on Saturday afternoon comes round next Sunday at six,
// not next Saturday afternoon. The slot is the open occurrence's own due time:
// moving it moves the setting, and turning it off sends the task to the Trash.

/** Sunday at six in the evening, until it is moved. */
export const CHECK_IN_DEFAULT = { weekday: 0, time: '18:00' } as const

/** The first `weekday` (0 = Sunday) at `time` (HH:MM, local) after `now`. */
export function nextSlot(now: Date, weekday: number, time: string): Date {
  const [h, m] = time.split(':').map(Number)
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number.isFinite(h) ? h : 18, Number.isFinite(m) ? m : 0, 0, 0)
  at.setDate(at.getDate() + ((weekday - at.getDay() + 7) % 7))
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 7)
  return at
}

/** The weekday and HH:MM an occurrence falls due on, on this device's clock. */
export function slotOf(dueAt: string): { weekday: number; time: string } {
  const d = new Date(dueAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return { weekday: d.getDay(), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }
}

/** The open weekly check-in of whoever is reading: theirs alone, as the reminders go by. */
export function openCheckIn(tasks: readonly Task[], myId?: string | null): Task | null {
  return (
    tasks
      .filter(t => isCheckIn(t) && !t.deletedAt && !!t.recurrence && OPEN_STATUSES.includes(t.status) && (!myId || !t.ownerId || t.ownerId === myId))
      .sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? ''))[0] ?? null
  )
}

/** The weekly check-in, first due at `at`. Private, like any new task: it is the reader's reminder. */
export function checkInTask(at: Date, o: { id: string; now: string }): Task {
  return {
    kind: 'task',
    id: `${CHECK_IN_PREFIX}${o.id}`,
    title: 'Check in your balances',
    description: 'Type in what each account holds today: Tasks → Finance → Check in. Safe to spend and the cash line are worked out from it.',
    status: 'todo',
    priority: 'normal',
    dueAt: at.toISOString(),
    recurrence: { freq: 'weekly' },
    createdAt: o.now,
    updatedAt: o.now,
    tags: [],
    shared: false,
  }
}

/**
 * The check-in a Check in just did: the open one, when it falls due within
 * two days (a Friday-evening check-in is that Sunday's) or already has. One
 * further off is next week's, and stays for its reminder.
 */
export function checkInDone(tasks: readonly Task[], myId: string | null | undefined, now: Date): Task | null {
  const t = openCheckIn(tasks, myId)
  if (!t?.dueAt) return null
  return dateKey(new Date(t.dueAt)) <= shiftDayKey(dateKey(now), 2) ? t : null
}
