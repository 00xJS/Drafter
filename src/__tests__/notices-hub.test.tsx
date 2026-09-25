import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NoticesSheet } from '../components/NoticesSheet'
import { Today } from '../components/Today'
import { hubOpener } from '../components/planner/hubRouting'
import type { PlannerCtx } from '../components/planner/ctx'
import { bellLabel, byDay, howLongAgo, hubRows, hubUnread, markHubSeen, messageNoticesShown, noticeOpens, readHubSeen, ringingDevice } from '../hub'
import { firedReminders, type FiredReminder } from '../reminders'
import type { CalendarEntry, Notice, Person, Place, Task } from '../types'
import { button, elements, rendered, textOf } from './rendered'

// The notification hub on Home: a bell with the count of what is new, and a
// sheet listing what the other member did to a task you share, the morning
// digest, alarms — and each reminder this device rang in the last week, so
// one swiped away unread can still be read. Notices are records, marked read
// with a newer stamp; reminders are worked out again and never stored.

const ME = 'me-0000-4000-8000-00000000000a'
const THEM = 'them-000-4000-8000-00000000000b'
const NOW = new Date(2026, 8, 23, 16, 0, 0) // 23 September, 4pm, local
const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m, 0)
const iso = (d: Date) => d.toISOString()

const notice = (over: Partial<Notice> = {}): Notice => ({
  kind: 'notice',
  id: `notice~${ME}~bins~1`,
  at: iso(at(23, 15, 30)),
  type: 'done',
  actorId: THEM,
  target: { kind: 'task', id: 'bins' },
  title: 'Maria finished “Take bins out”',
  lines: ['Ticked “Green bin”', 'Marked it done'],
  createdAt: iso(at(23, 15, 20)),
  updatedAt: iso(at(23, 15, 30)),
  ...over,
})
const task = (over: Partial<Task> = {}): Task => ({
  kind: 'task',
  id: 'bins',
  title: 'Take bins out',
  description: '',
  status: 'todo',
  priority: 'normal',
  tags: [],
  createdAt: iso(at(1, 9)),
  updatedAt: iso(at(1, 9)),
  ...over,
})
const reminder = (over: Partial<FiredReminder> = {}): FiredReminder => ({
  key: 'task:bins@1',
  at: at(23, 9),
  title: 'Reminder · Take bins out is due today',
  target: { kind: 'task', id: 'bins' },
  ...over,
})

describe('the bell’s number', () => {
  it('counts notices not yet read, and reminders that rang since the hub was last opened here', () => {
    const read = notice({ id: 'n2', readAt: iso(at(23, 15, 40)) })
    expect(hubUnread([notice(), read], [reminder(), reminder({ key: 'k2', at: at(22, 9) })], null)).toBe(3)
    // opened at noon today: this morning's reminder, and yesterday's, are seen
    expect(hubUnread([notice(), read], [reminder(), reminder({ key: 'k2', at: at(22, 9) })], at(23, 12).getTime())).toBe(1)
  })

  it('names itself with it', () => {
    expect(bellLabel(3)).toBe('Notifications, 3 unread')
    expect(bellLabel(0)).toBe('Notifications')
  })
})

describe('the rows', () => {
  it('newest first, under Today, Yesterday and then the date', () => {
    const rows = hubRows(
      [notice(), notice({ id: 'old', at: iso(at(21, 10)), title: 'Joe asked you to do “Book the dentist”', type: 'assigned', readAt: iso(at(21, 11)) })],
      [reminder(), reminder({ key: 'k2', at: at(22, 9), title: 'Reminder · Water the plants was due 9:00 AM' })],
      at(23, 12).getTime(),
    )
    expect(rows.map(r => [r.title, r.unread])).toEqual([
      ['Maria finished “Take bins out”', true],
      ['Reminder · Take bins out is due today', false],
      ['Reminder · Water the plants was due 9:00 AM', false],
      ['Joe asked you to do “Book the dentist”', false],
    ])
    expect(byDay(rows, '2026-09-23').map(g => [g.label, g.rows.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
      [expect.stringMatching(/Sep/), 1],
    ])
  })

  it('a deleted notice is not listed', () => {
    expect(hubRows([notice({ deletedAt: iso(NOW) })], [], null)).toEqual([])
  })

  it('say how long ago, then the time of day under the day’s heading', () => {
    const now = NOW.getTime()
    expect(howLongAgo(now - 20_000, now)).toBe('Just now')
    expect(howLongAgo(now - 12 * 60_000, now)).toBe('12 min ago')
    expect(howLongAgo(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(howLongAgo(at(23, 8, 5).getTime(), now)).toMatch(/8:05/)
  })
})

describe('the household thread reads the bell’s word of it', () => {
  const said = (over: Partial<Notice> = {}) =>
    notice({ id: `notice~${ME}~messages-${THEM}~1`, type: 'message', target: { kind: 'message', id: 'm2' }, title: 'Maria sent 2 messages', at: '2026-09-23T15:59:00.000Z', ...over })

  it('every unread message notice dated up to the newest message on screen, and nothing else', () => {
    const shown = said()
    const newer = said({ id: 'n-newer', at: '2026-09-23T16:05:00.000Z' })
    const read = said({ id: 'n-read', readAt: '2026-09-23T16:00:00.000Z' })
    const gone = said({ id: 'n-gone', deletedAt: '2026-09-23T16:00:00.000Z' })
    // a task's notice is read by opening the task, never by the chat
    const task = notice({ at: '2026-09-23T15:00:00.000Z' })
    expect(messageNoticesShown([shown, newer, read, gone, task], '2026-09-23T15:59:00.000Z').map(n => n.id)).toEqual([shown.id])
    // a stamp written another way is the same instant
    expect(messageNoticesShown([shown], '2026-09-23T15:59:00Z')).toEqual([shown])
    expect(messageNoticesShown([shown, newer], '2026-09-23T16:05:00.000Z')).toEqual([shown, newer])
  })

  it('none before the thread has shown anything', () => {
    expect(messageNoticesShown([said()], null)).toEqual([])
    expect(messageNoticesShown([said()], 'not a time')).toEqual([])
  })
})

describe('when the hub was last opened here', () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = new Map()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('is never, until it is opened; then it is kept, per device', () => {
    expect(readHubSeen()).toBeNull()
    markHubSeen(NOW.getTime())
    expect(readHubSeen()).toBe(NOW.getTime())
    expect(store.get('drafter:hub-seen')).toBe(String(NOW.getTime()))
  })
})

describe('the reminders that rang', () => {
  const data = (over: { tasks?: Task[]; people?: Person[]; places?: Place[] } = {}) => ({ tasks: [], people: [], places: [], meals: [], ...over })

  it('by the rule that set each: a time at its time, a day with none at 9am — and only the last week’s', () => {
    const tasks = [
      task({ id: 'timed', title: 'Call the vet', dueAt: iso(at(23, 14, 30)) }),
      task({ id: 'day', title: 'Take bins out', dueAt: iso(at(23, 0)) }),
      task({ id: 'past', title: 'Water the plants', dueAt: iso(at(20, 0)) }),
      task({ id: 'old', title: 'Too long ago', dueAt: iso(at(10, 9)) }),
      task({ id: 'later', title: 'Not yet', dueAt: iso(at(23, 18)) }),
      task({ id: 'done', title: 'Already done', status: 'done', dueAt: iso(at(23, 10)) }),
    ]
    const rang = firedReminders(data({ tasks }), NOW, { device: 'browser', myId: ME })
    expect(rang.map(r => r.title)).toEqual([
      expect.stringMatching(/^Reminder · Call the vet was due 2:30/),
      'Reminder · Take bins out is due today',
      'Reminder · Water the plants was due that day',
    ])
    expect(rang.map(r => r.target)).toEqual([
      { kind: 'task', id: 'timed' },
      { kind: 'task', id: 'day' },
      { kind: 'task', id: 'past' },
    ])
    expect(rang[1].at).toEqual(at(23, 9))
  })

  it('only the person doing it hears a task, as on the phones', () => {
    const tasks = [task({ id: 'theirs', dueAt: iso(at(23, 10)), ownerId: ME, assigneeId: THEM }), task({ id: 'mine', dueAt: iso(at(23, 10)), ownerId: THEM, assigneeId: ME })]
    expect(firedReminders(data({ tasks }), NOW, { device: 'phone', myId: ME }).map(r => r.target.id)).toEqual(['mine'])
  })

  it('my own events as they started; a birthday and a missed place only on the phone, which rings those', () => {
    const events: CalendarEntry[] = [
      { kind: 'event', id: 'e1', title: 'Dentist', start: iso(at(23, 11)), end: iso(at(23, 12)), createdAt: iso(at(1, 9)), updatedAt: iso(at(1, 9)) } as CalendarEntry,
      { kind: 'event', id: 'e2', title: 'Their night out', start: iso(at(23, 12)), end: iso(at(23, 13)), ownerId: THEM, createdAt: iso(at(1, 9)), updatedAt: iso(at(1, 9)) } as CalendarEntry,
    ]
    const people = [{ kind: 'person', id: 'mum', name: 'Mum', birthday: '1960-09-21', createdAt: iso(at(1, 9)), updatedAt: iso(at(1, 9)) } as Person]
    const browser = firedReminders(data({ people }), NOW, { device: 'browser', myId: ME, events })
    expect(browser.map(r => r.title)).toEqual([expect.stringMatching(/^Reminder · Dentist started at 11:00/)])
    const phone = firedReminders(data({ people }), NOW, { device: 'phone', myId: ME, events })
    expect(phone.map(r => r.title)).toEqual([expect.stringMatching(/^Reminder · Dentist started at/), "Reminder · Mum's birthday"])
    expect(phone[1].target).toEqual({ kind: 'person', id: 'mum' })
  })

  it('none on a device that rings none: a server render, or a browser not allowed to notify', () => {
    expect(ringingDevice()).toBeNull()
  })
})

describe('the bell on Home', () => {
  const noop = () => {}
  const renderToday = (over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <Today
        tasks={[task({ id: 'fence', title: 'Fix the fence' })]}
        people={[]}
        places={[]}
        reviews={[]}
        onPlanWith={noop}
        onWentTo={noop}
        onPlanAt={noop}
        onPlanOccasion={noop}
        onSaw={noop}
        onSaveReview={noop}
        projects={[]}
        events={[]}
        sourceMap={new Map()}
        onPlan={noop}
        onOpen={noop}
        onStatus={noop}
        onDefer={noop}
        onDeferAll={noop}
        onNew={noop}
        meals={[]}
        recipes={[]}
        onOpenKitchen={noop}
        onOpenReview={noop}
        onCookRecipe={noop}
        journal={[]}
        onSaveJournal={noop}
        onDeleteJournal={noop}
        onOpenJournal={noop}
        habits={[]}
        onSaveHabit={noop}
        onDeleteHabit={noop}
        routines={[]}
        onSaveRoutine={noop}
        onDeleteRoutine={noop}
        {...over}
      />,
    )

  it('sits on the greeting beside Review, named with its count', () => {
    const html = renderToday({ notices: [notice(), notice({ id: 'n2', readAt: iso(NOW) })], onOpenNotices: noop })
    // the greeting is Home's header now (2026-09-25): the bell rides on it, as it rode on the title line
    const head = html.slice(html.indexOf('class="today-head home-hero"'), html.indexOf('</header>'))
    expect(head).toMatch(/<h2>Good (morning|afternoon|evening)<\/h2>/)
    expect(head).toContain('aria-label="Notifications, 1 unread"')
    expect(head).toMatch(/class="today-bell-count" aria-hidden="true">1</)
    expect(head.indexOf('today-bell')).toBeLessThan(head.indexOf('>Review<'))
  })

  it('shows no count when nothing is new, and is not there without a hub to open', () => {
    const quiet = renderToday({ notices: [notice({ readAt: iso(NOW) })], onOpenNotices: noop })
    expect(quiet).toContain('aria-label="Notifications"')
    expect(quiet).not.toContain('today-bell-count')
    expect(renderToday()).not.toContain('today-bell')
  })

  it('is there on a planner with nothing else in it yet, when there is news', () => {
    expect(renderToday({ tasks: [], onOpenNotices: noop })).toContain('Welcome to your planner')
    const news = renderToday({ tasks: [], notices: [notice()], onOpenNotices: noop })
    expect(news).not.toContain('Welcome to your planner')
    expect(news).toContain('aria-label="Notifications, 1 unread"')
  })
})

describe('what a notice opens', () => {
  it('its own target, of a kind this build opens', () => {
    expect(noticeOpens(notice())).toEqual({ kind: 'task', id: 'bins' })
    expect(noticeOpens(notice({ id: `notice~${ME}~recap~2026-09`, target: { kind: 'insights', id: '2026-09' } }))).toEqual({ kind: 'insights', id: '2026-09' })
  })

  it('a recap that lost its target on an older phone: Insights on the month its id names', () => {
    expect(noticeOpens({ id: `notice~${ME}~recap~2026-09`, target: undefined })).toEqual({ kind: 'insights', id: '2026-09' })
    expect(noticeOpens({ id: `notice~${ME}~recap~2026-12`, target: undefined })).toEqual({ kind: 'insights', id: '2026-12' })
    // no month to read, or not a recap: nothing
    expect(noticeOpens({ id: `notice~${ME}~recap~2026-13`, target: undefined })).toBeUndefined()
    expect(noticeOpens({ id: `notice~${ME}~digest~2026-09-23`, target: undefined })).toBeUndefined()
  })

  it('nothing for a kind from a newer build, which the row keeps all the same', () => {
    expect(noticeOpens({ id: `notice~${ME}~recap~2026-09`, target: { kind: 'journal', id: '2026-09-24' } })).toBeUndefined()
    expect(hubRows([notice({ target: { kind: 'journal', id: '2026-09-24' } })], [], null)[0].target).toBeUndefined()
  })
})

describe('the sheet', () => {
  const props = (over: Record<string, unknown> = {}) => ({
    notices: [notice(), notice({ id: 'n-read', title: 'Maria commented on “Groceries”', type: 'comment' as const, lines: ['“Oat milk please”'], readAt: iso(at(23, 15, 45)), at: iso(at(23, 15, 40)) })],
    tasks: [],
    people: [],
    places: [],
    meals: [],
    events: [],
    myId: ME,
    onRead: () => {},
    onReadAll: () => {},
    onOpen: () => {},
    onClose: () => {},
    ...over,
  })

  it('is titled Notifications, lists each with its lines and an unread dot, and offers to mark all read', () => {
    const html = renderToStaticMarkup(<NoticesSheet {...props()} />)
    expect(html).toContain('>Notifications</h2>')
    expect(html).toContain('>Mark all as read</button>')
    expect(html).toContain('Maria finished “Take bins out”')
    expect(html).toContain('<span class="notice-line">Marked it done</span>')
    expect(html.match(/aria-label="Unread"/g)).toHaveLength(1)
    expect(html).toContain('notice-icon is-done')
  })

  it('a tap marks it read and opens what it is about; a read one only opens', () => {
    const read: string[] = []
    const opened: unknown[] = []
    const tree = rendered(NoticesSheet, props({ onRead: (n: Notice) => void read.push(n.id), onOpen: (t: unknown) => void opened.push(t) }))[0]
    const rows = elements(tree).filter(e => e.type === 'button' && String(e.props.className).startsWith('notice-row'))
    for (const row of rows) (row.props.onClick as () => void)()
    expect(read).toEqual([notice().id])
    expect(opened).toEqual([{ kind: 'task', id: 'bins' }, { kind: 'task', id: 'bins' }])
  })

  it('opens a recap a build-16 phone marked read, which lost its target, on the month its id names', () => {
    // the recap as the digest wrote it, and as build 16 wrote it back once read there
    const recap = notice({ id: `notice~${ME}~recap~2026-09`, type: 'digest', actorId: undefined, target: { kind: 'insights', id: '2026-09' }, title: 'Your September in Drafter', lines: ['6 tasks done in September'] })
    const stripped: Notice = { ...recap, target: undefined, readAt: iso(at(23, 15, 50)) }
    const opened: unknown[] = []
    const tree = rendered(NoticesSheet, props({ notices: [stripped], onOpen: (t: unknown) => void opened.push(t) }))[0]
    const row = elements(tree).find(e => e.type === 'button' && String(e.props.className).startsWith('notice-row'))!
    ;(row.props.onClick as () => void)()
    expect(opened).toEqual([{ kind: 'insights', id: '2026-09' }])
    // and it is drawn as the recap it was, the Insights glyph and all
    const drawn = (n: Notice) => renderToStaticMarkup(<NoticesSheet {...props({ notices: [n] })} />)
    expect(drawn(stripped)).toBe(drawn({ ...recap, readAt: stripped.readAt }))
  })

  it('marks all read in one go', () => {
    const all: Notice[][] = []
    const tree = rendered(NoticesSheet, props({ onReadAll: (ns: Notice[]) => void all.push(ns) }))[0]
    ;(button(tree, 'Mark all as read').props.onClick as () => void)()
    expect(all.map(ns => ns.map(n => n.id))).toEqual([[notice().id]])
  })

  it('says so when there is nothing, and offers nothing to mark', () => {
    const tree = rendered(NoticesSheet, props({ notices: [] }))[0]
    expect(textOf(tree)).toContain('You’re all caught up.')
    expect(() => button(tree, 'Mark all as read')).toThrow()
  })
})

describe('a row opens what it is about', () => {
  const ctx = () => {
    const calls: unknown[][] = []
    const log =
      (name: string) =>
      (...args: unknown[]) =>
        void calls.push([name, ...args])
    const p = {
      store: { tasks: [task()], events: [{ kind: 'event', id: 'e1', start: '2026-09-23T18:00:00.000Z' }] },
      openTask: log('openTask'),
      openReview: log('openReview'),
      openPerson: log('openPerson'),
      openPlace: log('openPlace'),
      setView: log('setView'),
      setEventEditor: log('setEventEditor'),
      setChatSide: log('setChatSide'),
      setPushed: log('setPushed'),
      showToast: log('showToast'),
    } as unknown as PlannerCtx
    return { p, calls }
  }

  it('a task in its editor, an event in its own, the review, a person, a place — closing the sheet first', () => {
    const { p, calls } = ctx()
    const open = hubOpener(p, () => calls.push(['close']))
    open({ kind: 'task', id: 'bins' })
    open({ kind: 'event', id: 'e1' })
    open({ kind: 'review', id: '2026-09-27' })
    open({ kind: 'person', id: 'mum' })
    open({ kind: 'place', id: 'nopi' })
    expect(calls.map(c => c[0])).toEqual(['close', 'openTask', 'close', 'setEventEditor', 'close', 'openReview', 'close', 'openPerson', 'close', 'openPlace'])
  })

  it('a household message opens the chat on the household’s thread, whichever message it names', () => {
    const { p, calls } = ctx()
    const open = hubOpener(p, () => calls.push(['close']))
    open({ kind: 'message', id: 'message~2026-09-23T16:00:00.000Z~abcdefghij' })
    open({ kind: 'message', id: 'not-on-this-device' })
    expect(calls).toEqual([['close'], ['setChatSide', 'household'], ['setPushed', 'chat'], ['close'], ['setChatSide', 'household'], ['setPushed', 'chat']])
  })

  it('a task that is not here says so, and an event that is not opens the Calendar', () => {
    const { p, calls } = ctx()
    const open = hubOpener(p)
    open({ kind: 'task', id: 'gone' })
    open({ kind: 'event', id: 'gone' })
    expect(calls).toEqual([['showToast', expect.stringMatching(/not on this device/)], ['setView', 'calendar']])
  })
})
