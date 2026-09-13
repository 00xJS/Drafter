import { Milestone, Project, Task, Template, TemplateTask } from './types'
import { uid } from './utils'
import { DAY_MS, startOfDay } from './taskutils'

// Built-in blueprints. Offsets are days from the project start; a negative
// offset is "before the event" for templates anchored on a date (a party, a
// holiday), where the start you pick is the day itself.

const T = (title: string, offsetDays: number, extra: Partial<TemplateTask> = {}): TemplateTask => ({ title, offsetDays, ...extra })

const BUILT_IN_STAMP = '2026-09-01T00:00:00.000Z'
type BuiltIn = Omit<Template, 'createdAt' | 'updatedAt'>
const builtIn = (list: BuiltIn[]): Template[] => list.map(t => ({ ...t, createdAt: BUILT_IN_STAMP, updatedAt: BUILT_IN_STAMP }))

export const BUILT_IN_TEMPLATES: Template[] = builtIn([
  {
    kind: 'template',
    id: 'tpl-holiday',
    name: 'Holiday / trip',
    emoji: '✈',
    color: '#22d3ee',
    description: 'Pick the departure date as the start. Everything is scheduled backwards from it.',
    durationDays: 7,
    tasks: [
      T('Book flights or transport', -45, { priority: 'high' }),
      T('Book accommodation', -40, { priority: 'high' }),
      T('Check passports and visas', -35, { checklist: ['Passport valid 6+ months', 'Visa / ETA if needed', 'Travel insurance'] }),
      T('Plan the rough itinerary', -21),
      T('Arrange pet / plant / house cover', -14),
      T('Book airport parking or transfer', -10),
      T('Buy currency, tell the bank', -7),
      T('Pack', -1, { checklist: ['Chargers', 'Medication', 'Documents printed', 'Adapters'] }),
      T('Set out-of-office', -1),
      T('Share photos and settle up costs', 8),
    ],
    milestones: [
      { name: 'Everything booked', offsetDays: -30 },
      { name: 'Departure', offsetDays: 0 },
    ],
  },
  {
    kind: 'template',
    id: 'tpl-move',
    name: 'Moving house',
    emoji: '🏠',
    color: '#fbbf24',
    description: 'Start = moving day. A 6-week countdown.',
    durationDays: 14,
    tasks: [
      T('Book removals or van', -42, { priority: 'high' }),
      T('Declutter room by room', -35, { checklist: ['Bedrooms', 'Kitchen', 'Garage / loft', 'Sell or donate'] }),
      T('Notify utilities and council', -28, { checklist: ['Electricity & gas', 'Water', 'Internet', 'Council tax'] }),
      T('Redirect post', -21),
      T('Update address everywhere', -21, { checklist: ['Bank', 'Employer', 'DVLA / licence', 'Insurance', 'Subscriptions'] }),
      T('Get packing materials', -14),
      T('Pack non-essentials', -10),
      T('Defrost the freezer, use up food', -3),
      T('Pack an essentials box', -1, { checklist: ['Kettle & mugs', 'Bedding', 'Toiletries', 'Tools', 'Chargers'] }),
      T('Final meter readings and photos', 0, { priority: 'high' }),
      T('Change the locks', 1),
      T('Unpack the kitchen and bedrooms', 2),
      T('Register with GP and dentist', 14),
    ],
    milestones: [
      { name: 'Packed', offsetDays: -1 },
      { name: 'Moving day', offsetDays: 0 },
      { name: 'Settled in', offsetDays: 14 },
    ],
  },
  {
    kind: 'template',
    id: 'tpl-party',
    name: 'Party / celebration',
    emoji: '🎉',
    color: '#f472b6',
    description: 'Start = the day of the party.',
    durationDays: 1,
    tasks: [
      T('Set the date, guest list and budget', -30),
      T('Book the venue or clear the house', -28, { priority: 'high' }),
      T('Send invitations', -21),
      T('Plan food and drink', -14, { checklist: ['Menu', 'Dietary needs', 'Drinks', 'Cake'] }),
      T('Order the cake', -10),
      T('Music, games, decorations', -7),
      T('Chase RSVPs', -5),
      T('Big shop', -2),
      T('Cook and set up', -1),
      T('Enjoy it — take photos', 0),
      T('Thank-yous and leftovers', 1),
    ],
    milestones: [{ name: 'Party', offsetDays: 0 }],
  },
  {
    kind: 'template',
    id: 'tpl-finances',
    name: 'Quarterly finances',
    emoji: '💰',
    color: '#34d399',
    description: 'Start = first day of the quarter. A 2-week sweep.',
    durationDays: 14,
    tasks: [
      T('Reconcile last quarter’s statements', 1),
      T('Review subscriptions — cancel the dead ones', 3, { checklist: ['Streaming', 'Apps', 'Memberships', 'Insurance renewals'] }),
      T('Check savings and emergency fund', 5),
      T('Review the budget vs actuals', 7),
      T('Update the net-worth spreadsheet', 9),
      T('Plan big purchases for the quarter', 10),
      T('File receipts and paperwork', 12),
    ],
    milestones: [{ name: 'Quarter closed', offsetDays: 14 }],
  },
  {
    kind: 'template',
    id: 'tpl-room',
    name: 'Room makeover',
    emoji: '🛋',
    color: '#f97316',
    description: 'Start = today. About six weeks from idea to done.',
    durationDays: 42,
    tasks: [
      T('Pin down the look: mood board and budget', 0, { checklist: ['Colours', 'Key pieces', 'Budget ceiling'] }),
      T('Measure the room and sketch a layout', 2),
      T('Get quotes for any trades', 5, { priority: 'high' }),
      T('Order paint and materials', 10),
      T('Order furniture with the longest lead time', 12, { priority: 'high' }),
      T('Clear and prep the room', 20),
      T('Paint', 22),
      T('Flooring / trades in', 26),
      T('Assemble and place furniture', 34),
      T('Hang, style, finish', 38),
      T('Photos and snag list', 42),
    ],
    milestones: [
      { name: 'Design locked', offsetDays: 5 },
      { name: 'Trades done', offsetDays: 30 },
      { name: 'Reveal', offsetDays: 42 },
    ],
  },
])

const stampAt = (start: Date, offsetDays: number, hour = 9): string => {
  const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offsetDays, hour, 0, 0)
  return d.toISOString()
}

/** Build a project and its tasks from a template anchored on a start date. */
export function instantiateTemplate(tpl: Template, start: Date, overrides: Partial<Project> = {}): { project: Project; tasks: Task[] } {
  const now = new Date().toISOString()
  const day = startOfDay(start)
  const offsets = tpl.tasks.map(t => t.offsetDays ?? 0).concat((tpl.milestones ?? []).map(m => m.offsetDays))
  const minOffset = Math.min(0, ...offsets)
  const maxOffset = Math.max(tpl.durationDays ?? 0, ...offsets)
  const project: Project = {
    kind: 'project',
    id: uid(),
    name: tpl.name,
    emoji: tpl.emoji,
    color: tpl.color,
    description: tpl.description,
    status: 'active',
    startAt: stampAt(day, minOffset, 12),
    targetAt: stampAt(day, maxOffset, 12),
    milestones: tpl.milestones?.map(m => ({ id: uid(), name: m.name, dueAt: stampAt(day, m.offsetDays, 12) })),
    notesHtml: tpl.notesHtml,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  const tasks: Task[] = tpl.tasks.map(t => ({
    kind: 'task',
    id: uid(),
    title: t.title,
    description: t.description ?? '',
    status: 'todo',
    priority: t.priority ?? 'normal',
    projectId: project.id,
    dueAt: t.offsetDays !== undefined ? stampAt(day, t.offsetDays) : undefined,
    createdAt: now,
    updatedAt: now,
    tags: t.tags ?? [],
    checklist: t.checklist?.map(text => ({ id: uid(), text, done: false })),
  }))
  return { project, tasks }
}

/**
 * A template's (or a drafted plan's) tasks and milestones added to a project
 * that already exists, dated from `start`. The project is passed as it now
 * stands and keeps everything of its own — name, colour, emoji, description,
 * dates, notepad, pin, owner — and only gains the milestones; its notepad takes
 * the template's notes only when it has none of any kind. Its start and target
 * are never filled in: a template's span is not the project's, and the one
 * ongoing project has no end (a target date would end its Timeline bar there).
 * The caller stamps it.
 */
export function extendProject(project: Project, tpl: Template, start: Date): { project: Project; tasks: Task[] } {
  const made = instantiateTemplate(tpl, start, { id: project.id })
  const milestones = [...(project.milestones ?? []), ...(made.project.milestones ?? [])]
  const next: Project = { ...project, milestones: milestones.length > 0 ? milestones : undefined }
  if (next.notesHtml === undefined && !next.notes && tpl.notesHtml) next.notesHtml = tpl.notesHtml
  return { project: next, tasks: made.tasks }
}

/** Capture an existing project as a reusable template (offsets relative to its start). */
export function templateFromProject(project: Project, tasks: Task[]): Template {
  const anchor = startOfDay(new Date(project.startAt ?? project.createdAt)).getTime()
  const offset = (iso?: string) => (iso ? Math.round((startOfDay(new Date(iso)).getTime() - anchor) / DAY_MS) : undefined)
  const now = new Date().toISOString()
  return {
    kind: 'template',
    id: uid(),
    name: project.name,
    emoji: project.emoji,
    color: project.color,
    description: project.description,
    durationDays: project.targetAt ? Math.max(1, offset(project.targetAt) ?? 1) : undefined,
    tasks: tasks
      .filter(t => t.status !== 'canceled')
      .sort((a, b) => (a.dueAt ?? '9').localeCompare(b.dueAt ?? '9'))
      .map(t => ({
        title: t.title,
        description: t.description || undefined,
        offsetDays: offset(t.dueAt),
        priority: t.priority !== 'normal' ? t.priority : undefined,
        checklist: t.checklist?.map(c => c.text),
        tags: t.tags.length ? t.tags : undefined,
      })),
    milestones: project.milestones?.filter((m): m is Milestone & { dueAt: string } => !!m.dueAt).map(m => ({ name: m.name, offsetDays: offset(m.dueAt) ?? 0 })),
    notesHtml: project.notesHtml,
    createdAt: now,
    updatedAt: now,
  }
}
