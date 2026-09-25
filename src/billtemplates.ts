import { localMidnightIso } from '../shared/domain.mts'
import type { Bill, BillKind, RecurrenceFreq, Task } from './types'

// + Bill's picker: the bills most US households pay, each a name, a kind, an
// emoji and how often it comes round, so adding the electric is a tap, an
// amount and a date rather than a blank form. Names and emoji only: a brand's
// logo or colours would be somebody else's artwork in the app, and a name is
// all a row needs. Every cadence is one RECURRENCE_META already has.

export type TemplateGroup = 'home' | 'car' | 'care' | 'streaming' | 'other'

export interface BillTemplate {
  key: string
  /** What the new bill is called; the tile says the same. */
  name: string
  emoji: string
  kind: Exclude<BillKind, 'income' | 'saving'>
  freq: RecurrenceFreq
  group: TemplateGroup
}

export const TEMPLATE_GROUPS: { key: TemplateGroup; label: string }[] = [
  { key: 'home', label: 'Home' },
  { key: 'car', label: 'Car' },
  { key: 'care', label: 'Health and family' },
  { key: 'streaming', label: 'Streaming and apps' },
  { key: 'other', label: 'Cards and anything else' },
]

export const BILL_TEMPLATES: BillTemplate[] = [
  { key: 'rent', name: 'Rent', emoji: '🏠', kind: 'bill', freq: 'monthly', group: 'home' },
  { key: 'mortgage', name: 'Mortgage', emoji: '🏡', kind: 'loan', freq: 'monthly', group: 'home' },
  { key: 'electric', name: 'Electric', emoji: '⚡', kind: 'bill', freq: 'monthly', group: 'home' },
  { key: 'water', name: 'Water & sewer', emoji: '💧', kind: 'bill', freq: 'monthly', group: 'home' },
  { key: 'gas', name: 'Gas', emoji: '🔥', kind: 'bill', freq: 'monthly', group: 'home' },
  { key: 'trash', name: 'Trash', emoji: '🗑️', kind: 'bill', freq: 'monthly', group: 'home' },
  { key: 'hoa', name: 'HOA', emoji: '🏘️', kind: 'bill', freq: 'monthly', group: 'home' },
  { key: 'internet', name: 'Internet', emoji: '🌐', kind: 'bill', freq: 'monthly', group: 'home' },
  { key: 'phone', name: 'Phone', emoji: '📱', kind: 'bill', freq: 'monthly', group: 'home' },
  { key: 'car-insurance', name: 'Car insurance', emoji: '🚗', kind: 'bill', freq: 'monthly', group: 'car' },
  { key: 'car-payment', name: 'Car payment', emoji: '🚙', kind: 'loan', freq: 'monthly', group: 'car' },
  { key: 'health-insurance', name: 'Health insurance', emoji: '🩺', kind: 'bill', freq: 'monthly', group: 'care' },
  { key: 'childcare', name: 'Childcare', emoji: '🧸', kind: 'bill', freq: 'monthly', group: 'care' },
  { key: 'gym', name: 'Gym', emoji: '🏋️', kind: 'subscription', freq: 'monthly', group: 'care' },
  { key: 'credit-card', name: 'Credit card', emoji: '💳', kind: 'card', freq: 'monthly', group: 'other' },
  { key: 'netflix', name: 'Netflix', emoji: '🎬', kind: 'subscription', freq: 'monthly', group: 'streaming' },
  { key: 'hulu', name: 'Hulu', emoji: '📺', kind: 'subscription', freq: 'monthly', group: 'streaming' },
  { key: 'disney', name: 'Disney+', emoji: '🏰', kind: 'subscription', freq: 'monthly', group: 'streaming' },
  { key: 'max', name: 'Max', emoji: '🎞️', kind: 'subscription', freq: 'monthly', group: 'streaming' },
  { key: 'spotify', name: 'Spotify', emoji: '🎧', kind: 'subscription', freq: 'monthly', group: 'streaming' },
  { key: 'youtube', name: 'YouTube Premium', emoji: '▶️', kind: 'subscription', freq: 'monthly', group: 'streaming' },
  { key: 'apple', name: 'Apple', emoji: '☁️', kind: 'subscription', freq: 'monthly', group: 'streaming' },
  { key: 'other', name: '', emoji: '🧾', kind: 'bill', freq: 'monthly', group: 'other' },
]

/** What the quick form under a template is filled in with. */
export interface QuickBill {
  name: string
  amount: number
  /** YYYY-MM-DD: the next time it falls due. */
  due: string
  freq: RecurrenceFreq
  autopay: boolean
  /** Who can see it, when there is a household to see it; left out alone. */
  shared?: boolean
}

/**
 * A bill from a template, as the editor would have saved it: a task with a
 * bill facet, the amount due as its estimate, falling due on the day with no
 * time (local midnight, the rule every due date reads) and repeating.
 */
export function billFromTemplate(t: Pick<BillTemplate, 'emoji' | 'kind'>, q: QuickBill, o: { id: string; now: string }): Task {
  return {
    kind: 'task',
    id: o.id,
    title: q.name.trim(),
    description: '',
    status: 'todo',
    priority: 'normal',
    dueAt: localMidnightIso(q.due) ?? undefined,
    recurrence: { freq: q.freq },
    bill: { kind: t.kind, emoji: t.emoji, ...(q.autopay ? { autopay: true } : {}) },
    estimateCost: Math.round(q.amount * 100) / 100,
    createdAt: o.now,
    updatedAt: o.now,
    tags: [],
    shared: q.shared ?? false,
  }
}

/** The emoji + Goal offers; any other can be typed. */
export const GOAL_EMOJI = ['🛟', '🏖️', '✈️', '🚗', '🏠', '🎓', '🎁', '💍', '🐷', '🎄']

export interface QuickGoal {
  name: string
  emoji: string
  /** What to reach, and by when (YYYY-MM-DD; optional). */
  target: number
  by?: string
  /** Each set-aside, how often, and the day of the first. */
  amount: number
  freq: RecurrenceFreq
  first: string
  autopay: boolean
  shared?: boolean
}

/**
 * A savings goal: a repeating set-aside with the goal on it. Progress is what
 * its finished occurrences paid in (savedSoFar), so there is nothing else to
 * write: each time one is marked done the goal moves.
 */
export function goalFromForm(g: QuickGoal, o: { id: string; now: string }): Task {
  const bill: Bill = {
    kind: 'saving',
    emoji: g.emoji || undefined,
    goal: { target: Math.round(g.target * 100) / 100, ...(g.by ? { by: g.by } : {}) },
    ...(g.autopay ? { autopay: true } : {}),
  }
  return {
    kind: 'task',
    id: o.id,
    title: g.name.trim(),
    description: '',
    status: 'todo',
    priority: 'normal',
    dueAt: localMidnightIso(g.first) ?? undefined,
    recurrence: { freq: g.freq },
    bill,
    estimateCost: Math.round(g.amount * 100) / 100,
    createdAt: o.now,
    updatedAt: o.now,
    tags: [],
    shared: g.shared ?? false,
  }
}

/** What + Payday's short form is filled in with. */
export interface QuickPayday {
  name: string
  /** Whose pay it is: a household member's id. Left out alone. */
  whose?: string
  amount: number
  /** YYYY-MM-DD: when the next one lands. The form will not add one without it. */
  due: string
  freq: RecurrenceFreq
  /** Who can see it, when there is a household to see it; left out alone. */
  shared?: boolean
}

/**
 * A payday: the bill facet with the sign the other way round (kind 'income'),
 * the amount paid in as its estimate, landing on the day with no time and
 * coming round again. What the editor would have saved, as a template's bill
 * is, so Finance counts it from the day it is added.
 */
export function paydayFromForm(p: QuickPayday, o: { id: string; now: string }): Task {
  return {
    kind: 'task',
    id: o.id,
    title: p.name.trim(),
    description: '',
    status: 'todo',
    priority: 'normal',
    dueAt: localMidnightIso(p.due) ?? undefined,
    recurrence: { freq: p.freq },
    bill: { kind: 'income', ...(p.whose ? { forMemberId: p.whose } : {}) },
    estimateCost: Math.round(p.amount * 100) / 100,
    createdAt: o.now,
    updatedAt: o.now,
    tags: [],
    shared: p.shared ?? false,
  }
}
