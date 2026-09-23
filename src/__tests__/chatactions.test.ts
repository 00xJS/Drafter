import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { AskDoc } from '../ask'
import { buildCapturedTask } from '../capture'
import {
  CHAT_PROMPTS,
  newTurn,
  recentContext,
} from '../chat'
import { THOUGHT_OUT_LOUD, looksLikeThinking } from '../ai'
import {
  CHAT_NUDGE,
  DROPPED,
  NO_ANSWER,
  applyChatAction,
  askInThread,
  askWithActions,
  buildChatPrompt,
  chatReplyThinks,
  buildTask,
  cardKey,
  cardState,
  chatActionContext,
  chatRecordId,
  describeAction,
  droppedLine,
  eventRecord,
  groceryAdd,
  mealPlan,
  needsPick,
  noteRecord,
  outcomeLine,
  outcomesByCard,
  parseChatReply,
  personChoices,
  resolveClock,
  resolveDay,
  resolvePerson,
  resolvePlace,
  resolveRecipe,
  taskChange,
  taskPreset,
  todayIn,
  visitTask,
  withPick,
  withoutClaims,
  type ChatActionContext,
  type ChatData,
  type ChatHost,
  type ChatReply,
} from '../chatactions'
import { buildEntry } from '../components/EventEditor'
import { sanitizeChatTurn, sanitizeItem } from '../schema'
import { hasDueTime } from '../taskutils'
import { addGroceryItem, buildGroceryList, groceryId } from '../../shared/kitchen.mts'
import { weekKeyOf } from '../../shared/weeks.mts'
import type { CalendarEntry, ChatAction, ChatTurn, GroceryList, Item, Meal, Note, Person, Place, Recipe, Task, TaskStatus } from '../types'

// The assistant chat can suggest changes, and nothing changes until one is
// tapped. These hold what the model is told, what of its reply is believed,
// how a name becomes a saved record, and that a record made from a card is the
// one the app's own editors would have made — private where they make it
// private, in the member's own row where they put it there.
//
// Everything runs in Phoenix, where the owner lives: at 20:30 on a Tuesday
// there, UTC has already moved on to Wednesday.

const zone = process.env.TZ
// Set before any fixture below is built, not in a beforeAll: a day's local
// midnight has to be Phoenix's midnight whatever zone the machine is in, and
// the build host is in UTC.
process.env.TZ = 'America/Phoenix'
afterAll(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})
afterEach(() => vi.unstubAllGlobals())

const TZ = 'America/Phoenix'
/** Tuesday 22 September 2026, 20:30 in Phoenix; already Wednesday in UTC. */
const NOW = new Date('2026-09-23T03:30:00.000Z')
const STAMP = '2026-09-01T12:00:00.000Z'
const ME = '11111111-1111-1111-1111-111111111111'

const person = (id: string, name: string): Person => ({ kind: 'person', id, name, color: '#f97316', group: 'family', createdAt: STAMP, updatedAt: STAMP })
const recipe = (id: string, name: string, ingredients: string[] = []): Recipe => ({
  kind: 'recipe',
  id,
  name,
  ingredients: ingredients.map((n, i) => ({ id: `${id}-i${i}`, name: n })),
  tags: [],
  createdAt: STAMP,
  updatedAt: STAMP,
})
const place = (id: string, name: string, aliases?: string[]): Place => ({ kind: 'place', id, name, color: '#f97316', category: 'restaurant', ...(aliases ? { aliases } : {}), createdAt: STAMP, updatedAt: STAMP })
const task = (id: string, title: string, over: Partial<Task> = {}): Task => ({
  kind: 'task',
  id,
  title,
  description: '',
  status: 'todo',
  priority: 'normal',
  createdAt: STAMP,
  updatedAt: STAMP,
  tags: [],
  ...over,
})
/** Local midnight on a day: due that day, with no time. */
const day = (m: number, d: number) => new Date(2026, m - 1, d).toISOString()

const PEOPLE = [person('p-mum', 'Mum'), person('p-dad', 'Dad'), person('p-sarah', 'Sarah Jones'), person('p-sarah2', 'Sarah Lee'), person('p-sam', 'Sam Smith')]
const RECIPES = [recipe('r-tacos', 'Beef tacos', ['Tortillas', 'Beef mince']), recipe('r-lasagne', 'Lasagne', ['Pasta sheets'])]
const PLACES = [place('l-pret', 'Pret A Manger', ['Pret']), place('l-nopi', 'Nopi')]
const TASKS = [
  task('t-plumber', 'Call the plumber', { dueAt: day(9, 24) }),
  task('t-gutters', 'Clean the gutters'),
  task('t-rent', 'Pay rent', { status: 'done', completedAt: STAMP }),
  task('t-paint', 'Paint the shed', { status: 'wishlist' }),
  task('t-dentist', 'Book the dentist', { dueAt: new Date(2026, 8, 24, 15, 0).toISOString() }),
]
const doc = (ref: string, kind: AskDoc['kind'], id: string, title: string): AskDoc => ({ ref, kind, id, title, text: '' })
const DOCS = [
  doc('T1', 'task', 't-plumber', 'Call the plumber'),
  doc('T2', 'task', 't-gutters', 'Clean the gutters'),
  doc('T3', 'task', 't-rent', 'Pay rent'),
  doc('T4', 'task', 't-paint', 'Paint the shed'),
  doc('T5', 'task', 't-dentist', 'Book the dentist'),
  doc('P1', 'person', 'p-mum', 'Mum'),
  doc('R1', 'recipe', 'r-tacos', 'Beef tacos'),
  doc('L1', 'place', 'l-nopi', 'Nopi'),
]

const question = (intents: string[] = ['meals', 'people']) => ({ intents: new Set(intents) as never, personIds: [], placeIds: [], recipeIds: [] })
const context = (intents?: string[]): ChatActionContext => chatActionContext(question(intents), DOCS, { people: PEOPLE, recipes: RECIPES, places: PLACES, tasks: TASKS }, { now: NOW, tz: TZ })
const reply = (actions: unknown[], answer = 'Here you go.') => JSON.stringify({ answer, cites: [], actions })
const read = (actions: unknown[]) => parseChatReply(reply(actions), context())

describe('today is the person’s day, wherever the clock is', () => {
  it('reads today in Phoenix, not UTC, late on a Tuesday evening', () => {
    expect(todayIn(TZ, NOW)).toBe('2026-09-22')
    expect(todayIn('UTC', NOW)).toBe('2026-09-23')
    expect(context().todayKey).toBe('2026-09-22')
  })

  it('reads a day the model said against that today', () => {
    const today = '2026-09-22'
    expect(resolveDay('2026-09-25', today)).toBe('2026-09-25')
    // "Friday", asked on a Tuesday evening, is this Friday — not Saturday, which a UTC today would make "tomorrow"
    expect(resolveDay('Friday', today)).toBe('2026-09-25')
    expect(resolveDay('fri', today)).toBe('2026-09-25')
    expect(resolveDay('thurs', today)).toBe('2026-09-24')
    expect(resolveDay('weds', today)).toBe('2026-09-23')
    // "month" is not Monday, and "tuesdays" is not a day
    expect(resolveDay('month', today)).toBeNull()
    expect(resolveDay('tuesdays', today)).toBeNull()
    expect(resolveDay('tomorrow', today)).toBe('2026-09-23')
    expect(resolveDay('today', today)).toBe(today)
    expect(resolveDay('tonight', today)).toBe(today)
    expect(resolveDay('yesterday', today)).toBe('2026-09-21')
    // on a Tuesday, "Tuesday" is today for a plan and "last Tuesday" a week back
    expect(resolveDay('tuesday', today)).toBe(today)
    expect(resolveDay('last tuesday', today)).toBe('2026-09-15')
    // Ask's own reading of "next": the next one after today
    expect(resolveDay('next Friday', today)).toBe('2026-09-25')
    expect(resolveDay('Sep 30', today)).toBe('2026-09-30')
    expect(resolveDay('1st October', today)).toBe('2026-10-01')
    expect(resolveDay('9/25', today)).toBe('2026-09-25')
    // a stamp is read for its day
    expect(resolveDay('2026-09-25T15:00:00Z', today)).toBe('2026-09-25')
  })

  it('leans back for something that already happened', () => {
    expect(resolveDay('Friday', '2026-09-22', 'back')).toBe('2026-09-18')
    expect(resolveDay('Sunday', '2026-09-22', 'back')).toBe('2026-09-20')
    expect(resolveDay('Sep 30', '2026-09-22', 'back')).toBe('2025-09-30')
  })

  it('refuses a day that does not exist or is out of reach', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2031-01-01', '1999-01-01', 'someday', 'the weekend', '', '   ']) expect(resolveDay(bad, '2026-09-22'), bad).toBeNull()
    expect(resolveDay(42, '2026-09-22')).toBeNull()
    expect(resolveDay(null, '2026-09-22')).toBeNull()
  })

  it('reads a time, and not a bare number', () => {
    expect(resolveClock('15:30')).toBe('15:30')
    expect(resolveClock('9:05')).toBe('09:05')
    expect(resolveClock('3pm')).toBe('15:00')
    expect(resolveClock('3:30 PM')).toBe('15:30')
    expect(resolveClock('12am')).toBe('00:00')
    expect(resolveClock('noon')).toBe('12:00')
    expect(resolveClock('2026-09-25T15:00:00Z')).toBe('15:00')
    for (const bad of ['3', '25:00', '10:75', '13pm', 'soon', '']) expect(resolveClock(bad), bad).toBeNull()
  })
})

describe('what the model is told', () => {
  const facts = ['Today is Tuesday, 22 September 2026 (America/Phoenix).']

  it('gives it today, a calendar to read days off, and the names it may use — never a real id', () => {
    const ctx = context()
    const { system, prompt } = buildChatPrompt('Plan tacos for Friday dinner', DOCS, facts, [], ctx)
    expect(system).toContain('Reply with ONLY JSON')
    expect(system).toContain('"actions"')
    expect(system).toContain('Nothing is changed until the user taps Apply')
    expect(system).toContain('At most 6 actions')
    expect(prompt).toContain('Today is Tuesday 2026-09-22 (America/Phoenix).')
    expect(prompt).toContain('Fri 2026-09-25')
    expect(prompt).toContain('Mon 2026-09-21')
    expect(prompt).toContain('People: Mum; Dad; Sarah Jones; Sarah Lee; Sam Smith')
    expect(prompt).toContain('Recipes: Beef tacos; Lasagne')
    expect(prompt).toContain('Places: Pret A Manger (also Pret); Nopi')
    expect(prompt).toContain('[T1] task · Call the plumber')
    // the question stays last, after everything it is about
    expect(prompt.trimEnd().split('\n').pop()).toBe('Question: Plan tacos for Friday dinner')
    for (const id of ['t-plumber', 'p-mum', 'r-tacos', 'l-nopi']) expect(prompt).not.toContain(id)
  })

  it('lists recipes and places only for a question that could need them', () => {
    const { prompt } = buildChatPrompt('Remind me to call the bank', [], facts, [], context(['tasks']))
    expect(prompt).toContain('People:')
    expect(prompt).not.toContain('Recipes:')
    expect(prompt).not.toContain('Places:')
  })

  it('keeps each list short', () => {
    const many = Array.from({ length: 50 }, (_, i) => person(`p${i}`, `Person ${i}`))
    const ctx = chatActionContext(question(), [], { people: many, recipes: [], places: [], tasks: [] }, { now: NOW, tz: TZ })
    const { prompt } = buildChatPrompt('q', [], facts, [], ctx)
    expect(prompt).toContain('; and 10 more')
    expect(prompt).not.toContain('Person 45')
  })

  it('makes one plain-text call of 900 tokens, and reads the JSON out of the reply', async () => {
    const calls: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)))
        return Response.json({ text: reply([{ type: 'add_grocery', items: ['milk', 'eggs'] }], 'I can add those [T9].') })
      }),
    )
    const r = await askWithActions('Add milk and eggs', DOCS, facts, [], context())
    expect(calls).toHaveLength(1)
    // not NVIDIA's JSON mode: forced to JSON, the model answered this prompt with {"":""}
    expect(calls[0]).toMatchObject({ maxTokens: 900, json: false })
    // a reference it was never shown is dropped from the words, as Ask drops one
    expect(r.answer).toBe('I can add those.')
    expect(r.actions).toEqual([{ type: 'add_grocery', items: ['milk', 'eggs'] }])
  })
})

describe('a suggestion is not a change', () => {
  it('drops a sentence that reports the change as made while it waits for Apply', () => {
    // what the live model wrote above its one card, before anyone tapped anything
    const r = parseChatReply(reply([{ type: 'add_grocery', items: ['paper towels'] }], 'Added paper towels to the grocery list.'), context())
    expect(r.answer).toBe('Here is a change you could make.')
    expect(r.actions).toEqual([{ type: 'add_grocery', items: ['paper towels'] }])
    expect(withoutClaims("You already have milk on the list. I've added eggs.")).toBe('You already have milk on the list.')
    expect(withoutClaims('I have planned tacos for Tuesday. Enjoy!')).toBe('Enjoy!')
    expect(withoutClaims('I can add eggs for you.')).toBe('I can add eggs for you.')
  })

  it('leaves the answer alone when nothing is proposed', () => {
    expect(parseChatReply(reply([], 'Added nothing: milk is already on the list.'), context()).answer).toBe('Added nothing: milk is already on the list.')
  })
})

describe('an empty reply', () => {
  const facts = ['Today is Tuesday, 22 September 2026 (America/Phoenix).']
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is asked for once more, and the second reply is read', async () => {
    const texts = ['{"":""}', reply([{ type: 'add_grocery', items: ['paper towels'] }], 'I can add paper towels.')]
    const calls: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)))
        return Response.json({ text: texts[calls.length - 1] })
      }),
    )
    const r = await askWithActions('Add paper towels', DOCS, facts, [], context())
    expect(calls).toHaveLength(2)
    expect(String(calls[1].system)).toMatch(/Fill in "answer"/)
    expect(r.actions).toEqual([{ type: 'add_grocery', items: ['paper towels'] }])
  })

  it('says so when the second reply is empty too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ text: '{"":""}' })))
    await expect(askWithActions('Add paper towels', DOCS, facts, [], context())).rejects.toThrow(NO_ANSWER)
  })
})

// 93bb7e8 told the chat what it can and cannot do, and put the JSON templates
// in its brief; the thinking check read the whole reply against the whole
// brief, so right answers that said either back were asked again and could
// end in "The model thought out loud". Now only the words shown are checked,
// and only against the rules on how to answer.
describe('thinking out loud, told apart from a right answer', () => {
  const facts = ['Today is Tuesday, 22 September 2026 (America/Phoenix).']
  const brief = () => buildChatPrompt('Can you text Maria for me?', DOCS, facts, [], context())
  const CANNOT = JSON.stringify({ answer: "I can't send messages to anyone or look anything up online, but I can add a task to text Maria.", cites: [], actions: [] })
  const MOVE = JSON.stringify({
    answer: 'I can move the plumber to Friday.',
    cites: ['T1'],
    actions: [{ type: 'update_task', ref: 'T1', date: '2026-09-25', time: '15:00', status: 'todo', priority: 'high' }],
  })
  const ABOUT = JSON.stringify({ answer: 'I answer questions about your tasks, people, places, meals, calendar, bills and clothes.', cites: [], actions: [] })
  const RULES_BACK = 'The user wants the plumber moved. An existing task can be changed only through its reference from the records, so I will use T1.'

  it('a right answer that says what the assistant can do, or suggests a change in its template, is not thinking', () => {
    const { system, rules } = brief()
    for (const r of [CANNOT, MOVE, ABOUT]) {
      // the old check, the whole reply against the whole brief, calls every one of these thinking
      expect(looksLikeThinking(r, system), r).toBe(true)
      expect(chatReplyThinks(r, rules), r).toBe(false)
    }
    // the rules leave out who it is, what it can do and the templates, and nothing else
    expect(rules).not.toMatch(/send messages|You are the assistant|"type":/)
    expect(rules).toContain('Cite every fact you use from the records')
    expect(system).toContain(rules)
  })

  it('still catches a reply that says the rules back, in its answer or with no JSON at all', () => {
    const { rules } = brief()
    expect(chatReplyThinks(RULES_BACK, rules)).toBe(true)
    expect(chatReplyThinks(JSON.stringify({ answer: 'We must cite every fact you use from the records with its reference.', actions: [] }), rules)).toBe(true)
  })

  const replies = (texts: string[]) => {
    const calls: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)))
        return Response.json({ text: texts[Math.min(calls.length, texts.length) - 1] })
      }),
    )
    return calls
  }

  it('takes a right answer that echoes the brief the first time, where it used to ask again and could fail', async () => {
    const calls = replies([CANNOT])
    const r = await askWithActions('Can you text Maria for me?', DOCS, facts, [], context())
    expect(calls).toHaveLength(1)
    expect(r.answer).toContain("I can't send messages to anyone")
    const move = replies([MOVE])
    expect((await askWithActions('Move the plumber to Friday at 3pm', DOCS, facts, [], context())).actions).toEqual([
      { type: 'update_task', taskId: 't-plumber', title: 'Call the plumber', date: '2026-09-25', time: '15:00', priority: 'high' },
    ])
    expect(move).toHaveLength(1)
  })

  it('asks once more, with reasoning off, when the reply is the rules said back — and says so when the second is too', async () => {
    const calls = replies([RULES_BACK, MOVE])
    expect((await askWithActions('Move the plumber to Friday at 3pm', DOCS, facts, [], context())).answer).toBe('I can move the plumber to Friday.')
    expect(calls).toHaveLength(2)
    expect(calls[0]).not.toHaveProperty('reasoning')
    expect(calls[1]).toMatchObject({ maxTokens: 900, json: false, reasoning: 'off' })
    expect(String(calls[1].system)).toContain(CHAT_NUDGE)
    replies([RULES_BACK])
    await expect(askWithActions('Move the plumber to Friday at 3pm', DOCS, facts, [], context())).rejects.toThrow(THOUGHT_OUT_LOUD)
  })
})

describe('a question in the thread', () => {
  const at = new Date('2026-09-23T03:30:00.000Z')
  const answer = (text: string): ChatReply => ({ answer: text, cites: [], actions: [], dropped: [] })

  it('is written at once, before the answer, and the answer after it — even within the same millisecond', async () => {
    const written: ChatTurn[] = []
    let answered!: (r: ChatReply) => void
    const done = askInThread({ question: 'What is due tomorrow?', lock: { current: false }, write: t => written.push(t), ask: () => new Promise(r => (answered = r)), now: () => at })
    await Promise.resolve()
    // the question is there while the model is still thinking
    expect(written.map(t => [t.role, t.text])).toEqual([['you', 'What is due tomorrow?']])
    answered(answer('Two things.'))
    expect(await done).toEqual({ asked: written[0] })
    expect(written.map(t => [t.role, t.text])).toEqual([
      ['you', 'What is due tomorrow?'],
      ['drafter', 'Two things.'],
    ])
    expect(written[1].createdAt > written[0].createdAt).toBe(true)
    expect(written[1].id > written[0].id).toBe(true)
  })

  it('is asked once however often Enter is pressed while it is out', async () => {
    const lock = { current: false }
    const asks: string[] = []
    const written: ChatTurn[] = []
    const one = (q: string) => askInThread({ question: q, lock, write: t => written.push(t), ask: async () => (asks.push(q), answer('Yes.')) })
    const [first, second] = await Promise.all([one('Anything due?'), one('Anything due?')])
    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(asks).toEqual(['Anything due?'])
    expect(written).toHaveLength(2)
    // and once it is answered, the next question goes
    expect(await one('And Friday?')).not.toBeNull()
    expect(lock.current).toBe(false)
  })

  it('writes nothing for a failure, and Try again asks the same question without writing it twice', async () => {
    const written: ChatTurn[] = []
    const lock = { current: false }
    const failed = await askInThread({ question: 'Tell me about my week', lock, write: t => written.push(t), ask: async () => Promise.reject(new Error('The server is unreachable from here')) })
    expect(failed?.error).toBeInstanceOf(Error)
    // only the question: the failure is said on this screen, not saved as something Drafter said
    expect(written.map(t => t.role)).toEqual(['you'])
    const again = await askInThread({ question: 'Tell me about my week', lock, asked: failed!.asked, write: t => written.push(t), ask: async () => answer('A quiet one.') })
    expect(again).toEqual({ asked: failed!.asked })
    expect(written.map(t => [t.role, t.text])).toEqual([
      ['you', 'Tell me about my week'],
      ['drafter', 'A quiet one.'],
    ])
  })
})

describe('reading the reply leniently', () => {
  it('finds the JSON in fences and chatter', () => {
    const r = parseChatReply(`Sure! \`\`\`json\n${reply([{ type: 'create_note', title: 'Gift ideas', text: 'A scarf' }], 'I can save that [T1].')}\n\`\`\` Hope that helps`, context())
    expect(r.answer).toBe('I can save that [T1].')
    expect(r.cites).toEqual(['T1'])
    expect(r.actions).toHaveLength(1)
  })

  it('ignores thinking, closed or not, and a trailing comma', () => {
    expect(parseChatReply('<think>{"answer":"not this"}</think>{"answer":"This one","actions":[]}', context()).answer).toBe('This one')
    expect(parseChatReply('the user wants milk, so {"answer": "draft"} </think> {"answer":"Real"}', context()).answer).toBe('Real')
    const r = parseChatReply('{"answer":"ok","actions":[{"type":"add_grocery","items":["milk",],},],}', context())
    expect(r.actions).toEqual([{ type: 'add_grocery', items: ['milk'] }])
  })

  it('takes a reply that ignored the JSON as the answer, with nothing to apply', () => {
    expect(parseChatReply('You have two things due tomorrow.', context())).toMatchObject({ answer: 'You have two things due tomorrow.', actions: [] })
  })

  it('gives suggestions with no words a line of their own, and refuses a reply with neither', () => {
    expect(parseChatReply(JSON.stringify({ actions: [{ type: 'add_grocery', items: ['milk'] }] }), context()).answer).toBe('Here is a change you could make.')
    expect(() => parseChatReply('{"answer": ""}', context())).toThrow(/no answer/)
    expect(() => parseChatReply('{"answer": ', context())).toThrow(/no answer/)
  })
})

describe('checking every suggestion', () => {
  it('drops a date that does not exist, and says so in one line', () => {
    const r = read([{ type: 'create_task', title: 'Renew the car tax', date: '2026-02-30' }])
    expect(r.actions).toEqual([])
    expect(r.dropped).toEqual([DROPPED.date])
    expect(r.answer).toBe('Here you go.\n\nLeft out 1 suggestion (a date that doesn’t exist).')
  })

  it('changes an existing task only through a reference it was shown', () => {
    const r = read([
      { type: 'update_task', ref: 'T9', status: 'done' },
      // a real id is not a reference
      { type: 'update_task', ref: 't-plumber', status: 'done' },
      // a reference to a person is not a task
      { type: 'update_task', ref: 'P1', status: 'done' },
      { type: 'update_task', ref: '[T1]', status: 'done' },
    ])
    expect(r.dropped).toEqual([DROPPED.ref, DROPPED.ref, DROPPED.ref])
    expect(r.actions).toEqual([{ type: 'update_task', taskId: 't-plumber', title: 'Call the plumber', status: 'done' }])
  })

  it('keeps six and leaves out the rest', () => {
    const r = read(Array.from({ length: 8 }, (_, i) => ({ type: 'add_grocery', items: [`item ${i}`] })))
    expect(r.actions).toHaveLength(6)
    expect(r.dropped).toEqual([DROPPED.many, DROPPED.many])
    expect(r.answer).toContain('Left out 2 suggestions (more than 6 at once).')
  })

  it('drops the wrong shape, and anything it cannot do — deleting included', () => {
    const r = read([
      { type: 'create_task', title: { text: 'x' } },
      { type: 'add_grocery', items: 5 },
      { type: 'delete_task', ref: 'T1' },
      { type: 'constructor' },
      'buy milk',
      { type: 'create_event', title: 'Dentist', date: '2026-09-25', start: '15:00', end: '14:00' },
      { type: 'create_event', title: 'Dentist', date: '2026-09-25', start: 'soon' },
      { type: 'create_task', title: 'Walk', priority: 'p1' },
      { type: 'log_visit', people: ['Mum'], date: '2026-09-30' },
      { type: 'plan_meal', slot: 'dinner', dish: 'Lasagne' },
    ])
    expect(r.actions).toEqual([])
    expect(r.dropped).toEqual([DROPPED.shape, DROPPED.shape, DROPPED.kind, DROPPED.kind, DROPPED.shape, DROPPED.backwards, DROPPED.time, DROPPED.value, DROPPED.future, DROPPED.missing])
    expect(droppedLine(r.dropped).split('(')[0]).toBe('Left out 10 suggestions ')
  })

  it('drops a change that would change nothing', () => {
    const r = read([
      { type: 'update_task', ref: 'T1', priority: 'normal' },
      { type: 'update_task', ref: 'T1', date: '2026-09-24' },
      // Reschedule leaves a finished task where it is
      { type: 'update_task', ref: 'T3', date: '2026-09-25' },
    ])
    expect(r.actions).toEqual([])
    expect(r.dropped).toEqual([DROPPED.same, DROPPED.same, DROPPED.same])
  })

  it('reads the words open models use for the same things', () => {
    const r = read([
      { type: 'add_task', title: 'Call the bank', dueDate: 'Friday', time: '9am', priority: 'medium', tags: '#money', people: 'mum' },
      { action: 'complete_task', ref: 'T2' },
      { type: 'grocery', items: 'milk, eggs; bread' },
      { type: 'meal', date: 'friday', meal: 'supper', recipe: 'beef tacos' },
    ])
    expect(r.dropped).toEqual([])
    expect(r.actions).toEqual([
      { type: 'create_task', title: 'Call the bank', date: '2026-09-25', time: '09:00', priority: 'normal', tags: ['money'], people: [{ name: 'Mum', id: 'p-mum' }] },
      { type: 'update_task', taskId: 't-gutters', title: 'Clean the gutters', status: 'done' },
      { type: 'add_grocery', items: ['milk', 'eggs', 'bread'] },
      { type: 'plan_meal', date: '2026-09-25', slot: 'dinner', dish: { name: 'Beef tacos', id: 'r-tacos' } },
    ])
  })

  it('says a suggestion once however often it is repeated', () => {
    expect(read([{ type: 'add_grocery', items: ['milk'] }, { type: 'add_grocery', items: ['milk'] }]).actions).toHaveLength(1)
  })

  it('reads a time alone as today, and a new time as a move on the day it is due', () => {
    const r = read([
      { type: 'create_task', title: 'Take the bins out', time: '19:00' },
      { type: 'update_task', ref: 'T1', time: '10:30' },
    ])
    expect(r.actions).toEqual([
      { type: 'create_task', title: 'Take the bins out', date: '2026-09-22', time: '19:00' },
      { type: 'update_task', taskId: 't-plumber', title: 'Call the plumber', date: '2026-09-24', time: '10:30' },
    ])
  })
})

describe('names, matched to what is saved', () => {
  it('matches a person whatever the case, and by first name when only one person has it', () => {
    expect(resolvePerson('mum', PEOPLE)).toEqual({ name: 'Mum', id: 'p-mum' })
    expect(resolvePerson('  SAM  ', PEOPLE)).toEqual({ name: 'Sam Smith', id: 'p-sam' })
    expect(resolvePerson('sarah lee', PEOPLE)).toEqual({ name: 'Sarah Lee', id: 'p-sarah2' })
  })

  it('never guesses between two people of the same name', () => {
    const ref = resolvePerson('Sarah', PEOPLE)
    expect(ref).toEqual({ name: 'Sarah' })
    expect(personChoices('Sarah', PEOPLE).slice(0, 2).map(p => p.id)).toEqual(['p-sarah', 'p-sarah2'])
    const a = read([{ type: 'log_visit', people: ['Sarah', 'Dad'], date: 'yesterday' }]).actions[0]
    expect(needsPick(a)).toEqual([{ field: 'people', index: 0, name: 'Sarah' }])
    expect(describeAction(a, dataOf(), '2026-09-22').blocked).toBe('Pick who “Sarah” is')
  })

  it('finds a place by another name it goes by, and a recipe by its whole name', () => {
    expect(resolvePlace('pret', PLACES)).toEqual({ name: 'Pret A Manger', id: 'l-pret' })
    expect(resolvePlace('Taco Bell', PLACES)).toEqual({ name: 'Taco Bell' })
    expect(resolveRecipe('beef TACOS', RECIPES)).toEqual({ name: 'Beef tacos', id: 'r-tacos' })
    // part of a name is not the name
    expect(resolveRecipe('tacos', RECIPES)).toEqual({ name: 'tacos' })
  })

  it('takes a reference it was shown for a name', () => {
    expect(resolvePerson('P1', PEOPLE, DOCS)).toEqual({ name: 'Mum', id: 'p-mum' })
    expect(resolveRecipe('[R1]', RECIPES, DOCS)).toEqual({ name: 'Beef tacos', id: 'r-tacos' })
    expect(resolvePlace('L1', PLACES, DOCS)).toEqual({ name: 'Nopi', id: 'l-nopi' })
    // a reference to a task is not a person
    expect(resolvePerson('T1', PEOPLE, DOCS)).toEqual({ name: 'T1' })
  })

  it('leaves the person asking out of the people', () => {
    expect(read([{ type: 'log_visit', people: ['me', 'Mum'] }]).actions[0]).toEqual({ type: 'log_visit', people: [{ name: 'Mum', id: 'p-mum' }], date: '2026-09-22' })
  })

  it('fixes a name with a pick: someone saved, left out, a new recipe, or no saved place', () => {
    const d = dataOf()
    const visit = read([{ type: 'log_visit', people: ['Sarah', 'Dad'] }]).actions[0]
    expect(withPick(visit, { field: 'people', index: 0, id: 'p-sarah2' }, d)).toMatchObject({ people: [{ name: 'Sarah Lee', id: 'p-sarah2' }, { name: 'Dad', id: 'p-dad' }] })
    expect(withPick(visit, { field: 'people', index: 0, id: null }, d)).toMatchObject({ people: [{ name: 'Dad', id: 'p-dad' }] })
    const meal = read([{ type: 'plan_meal', date: 'Tuesday', slot: 'dinner', dish: 'tacos' }]).actions[0]
    expect(needsPick(meal)).toEqual([{ field: 'dish', name: 'tacos' }])
    expect(needsPick(withPick(meal, { field: 'dish', id: 'new' }, d))).toEqual([])
    expect(withPick(meal, { field: 'dish', id: 'r-tacos' }, d)).toMatchObject({ dish: { name: 'Beef tacos', id: 'r-tacos' } })
    const out = read([{ type: 'plan_meal', date: 'Tuesday', place: 'Taco Bell' }]).actions[0]
    expect(needsPick(out)).toEqual([{ field: 'place', name: 'Taco Bell' }])
    expect(withPick(out, { field: 'place', id: null }, d)).toEqual({ type: 'plan_meal', date: '2026-09-22', slot: 'dinner', out: true, title: 'Taco Bell' })
  })
})

/** The planner as the cards read it, with a household or without. */
function dataOf(over: Partial<ChatData> = {}): ChatData {
  return { people: PEOPLE, recipes: RECIPES, places: PLACES, tasks: TASKS, meals: [], mealRows: [], groceries: [], notes: [], events: [], myId: ME, inHousehold: true, ...over }
}

describe('a record made from a card is the one the app would make', () => {
  const create = (over: Partial<Extract<ChatAction, { type: 'create_task' }>> = {}) => ({ type: 'create_task' as const, title: 'Call the plumber', ...over })

  it('makes a task as + New task saves one: private until shared, due that day with no time', () => {
    const t = buildTask(create({ date: '2026-09-25', priority: 'high', tags: ['home'], people: [{ name: 'Mum', id: 'p-mum' }], notes: 'Ask about the boiler' }), { id: 'task~x', now: NOW })
    expect(t).toMatchObject({
      kind: 'task',
      id: 'task~x',
      title: 'Call the plumber',
      description: 'Ask about the boiler',
      status: 'todo',
      priority: 'high',
      dueAt: day(9, 25),
      tags: ['home'],
      peopleIds: ['p-mum'],
      shared: false,
      createdAt: NOW.toISOString(),
    })
    expect(hasDueTime(t.dueAt!)).toBe(false)
    expect(t.updatedAt > t.createdAt).toBe(true)
    // a time is a time: 15:00 in Phoenix
    expect(buildTask(create({ date: '2026-09-25', time: '15:00' }), { id: 'x', now: NOW }).dueAt).toBe('2026-09-25T22:00:00.000Z')
  })

  it('has every field the palette’s capture fills, and the privacy + New task adds', () => {
    const fields = { title: 'Call the plumber', dueAt: day(9, 25), priority: 'high' as const, tags: ['home'], peopleNames: ['Mum'] }
    const captured = buildCapturedTask(fields, { people: PEOPLE }, { id: 'x', now: NOW })
    const made = buildTask(create({ date: '2026-09-25', priority: 'high', tags: ['home'], people: [{ name: 'Mum', id: 'p-mum' }] }), { id: 'x', now: NOW })
    for (const key of ['kind', 'title', 'description', 'status', 'priority', 'dueAt', 'tags', 'peopleIds', 'createdAt'] as const) expect(made[key], key).toEqual(captured[key])
    expect(made.shared).toBe(false)
  })

  it('hands the task editor the same task to open on', () => {
    const preset = taskPreset(create({ date: '2026-09-25' }), 'task~y')
    expect(preset).toMatchObject({ id: 'task~y', title: 'Call the plumber', dueAt: day(9, 25), shared: false, status: 'todo' })
  })

  it('moves a task as Reschedule does: its time of day kept, 09:00 when it had no date, back to do from the wishlist', () => {
    const dentist = TASKS.find(t => t.id === 't-dentist')!
    expect(taskChange({ type: 'update_task', taskId: dentist.id, title: '', date: '2026-09-25' }, dentist).patch.dueAt).toBe(new Date(2026, 8, 25, 15, 0).toISOString())
    const gutters = TASKS.find(t => t.id === 't-gutters')!
    expect(taskChange({ type: 'update_task', taskId: gutters.id, title: '', date: '2026-09-25' }, gutters).patch.dueAt).toBe(new Date(2026, 8, 25, 9, 0).toISOString())
    const shed = TASKS.find(t => t.id === 't-paint')!
    expect(taskChange({ type: 'update_task', taskId: shed.id, title: '', date: '2026-09-25' }, shed).status).toBe('todo')
    expect(taskChange({ type: 'update_task', taskId: shed.id, title: '', priority: 'high' }, shed)).toEqual({ patch: { priority: 'high' } })
  })

  it('adds grocery lines as the Kitchen’s add box does, to the member’s own list for the week', () => {
    const week = weekKeyOf('2026-09-22')!
    const mine: GroceryList = {
      kind: 'grocery',
      id: groceryId(week, ME),
      weekKey: week,
      items: [{ id: 'g1', name: 'Milk', state: 'done', recipeIds: [], manual: true }],
      ownerId: ME,
      createdAt: STAMP,
      updatedAt: STAMP,
    }
    const theirs: GroceryList = { ...mine, id: groceryId(week, 'someone-else'), ownerId: 'someone-else', items: [] }
    let n = 0
    const { list, added } = groceryAdd({ type: 'add_grocery', items: ['milk', 'eggs'] }, { groceries: [theirs, mine], meals: [], recipes: RECIPES, myId: ME }, { todayKey: '2026-09-22', now: NOW, newId: () => `new${++n}` })
    // what the add box writes: addGroceryItem, one name at a time
    let expected = mine.items
    let m = 0
    for (const name of ['milk', 'eggs']) expected = addGroceryItem(expected, { name }, () => `new${++m}`).items
    expect(list.id).toBe(mine.id)
    expect(list.items).toEqual(expected)
    expect(list.items[0]).toMatchObject({ name: 'Milk', state: 'need' })
    expect(added.map(a => a.outcome)).toEqual(['merged', 'added'])
    expect(list.updatedAt > mine.updatedAt).toBe(true)
  })

  it('starts a week’s list from its meals, in a row that carries the member, and a date means that week', () => {
    const meal: Meal = { kind: 'meal', id: 'meal~2026-09-30~dinner', date: '2026-09-30', slot: 'dinner', recipeId: 'r-lasagne', title: 'Lasagne', createdAt: STAMP, updatedAt: STAMP }
    const { list, prev } = groceryAdd({ type: 'add_grocery', items: ['bread'], date: '2026-09-30' }, { groceries: [], meals: [meal], recipes: RECIPES, myId: ME }, { todayKey: '2026-09-22', now: NOW, newId: () => 'b1' })
    const week = weekKeyOf('2026-09-30')!
    expect(prev).toBeNull()
    expect(list.id).toBe(`grocery~${week}~${ME}`)
    expect(list.weekKey).toBe(week)
    expect(list.items.map(i => i.name)).toEqual([...buildGroceryList(week, [meal], RECIPES, null, STAMP, ME).items.map(i => i.name), 'bread'])
  })

  it('plans a meal as the Kitchen’s slot picker does: the member’s own row, Just me in a household', () => {
    const plan = mealPlan({ type: 'plan_meal', date: '2026-09-29', slot: 'dinner', dish: { name: 'Beef tacos', id: 'r-tacos' } }, dataOf(), { now: NOW, recipe: RECIPES[0] })!
    expect(plan.before).toBeNull()
    expect(plan.meal).toMatchObject({ kind: 'meal', id: `meal~2026-09-29~dinner~${ME}`, date: '2026-09-29', slot: 'dinner', recipeId: 'r-tacos', title: 'Beef tacos', shared: false })
    // alone there is nobody to share with, and nothing is said
    expect(mealPlan({ type: 'plan_meal', date: '2026-09-29', slot: 'dinner', dish: { name: 'Beef tacos', id: 'r-tacos' } }, dataOf({ inHousehold: false, myId: null }), { now: NOW, recipe: RECIPES[0] })!.meal).not.toHaveProperty(
      'shared',
    )
  })

  it('builds on the meal already in the slot, and on a cleared slot’s tombstone', () => {
    const there: Meal = { kind: 'meal', id: 'meal~2026-09-29~dinner', date: '2026-09-29', slot: 'dinner', recipeId: 'r-lasagne', title: 'Lasagne', notes: 'Double batch', sides: [{ title: 'Salad' }], ownerId: ME, createdAt: STAMP, updatedAt: STAMP }
    const plan = mealPlan({ type: 'plan_meal', date: '2026-09-29', slot: 'dinner', dish: { name: 'Beef tacos', id: 'r-tacos' } }, dataOf({ meals: [there], mealRows: [there] }), { now: NOW, recipe: RECIPES[0] })!
    // the legacy id stays, the notes and sides stay, and a meal already on the week keeps its audience
    expect(plan.meal).toMatchObject({ id: there.id, recipeId: 'r-tacos', notes: 'Double batch', sides: [{ title: 'Salad' }] })
    expect(plan.meal).not.toHaveProperty('shared')
    expect(plan.before).toBe(there)
    const gone = { ...there, deletedAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z' }
    const again = mealPlan({ type: 'plan_meal', date: '2026-09-29', slot: 'dinner', out: true, place: { name: 'Nopi', id: 'l-nopi' } }, dataOf({ mealRows: [gone] }), { now: NOW })!
    expect(again.meal).toMatchObject({ id: there.id, out: true, placeId: 'l-nopi', title: 'Nopi', shared: false })
    expect(again.meal.updatedAt > gone.updatedAt).toBe(true)
    expect(again.meal).not.toHaveProperty('sides')
  })

  it('logs a visit as People’s Saw them… does: done at local noon, tagged visit, with whoever it was', () => {
    const v = visitTask({ type: 'log_visit', people: [{ name: 'Mum', id: 'p-mum' }], date: '2026-09-21' }, dataOf(), { id: 'task~v', now: NOW })!
    expect(v).toMatchObject({ kind: 'task', id: 'task~v', title: 'Saw Mum', status: 'done', completedAt: new Date(2026, 8, 21, 12, 0).toISOString(), tags: ['visit'], peopleIds: ['p-mum'], description: '' })
    // a visit carries no flag of its own, as People's log writes none
    expect(v).not.toHaveProperty('shared')
    const at = visitTask({ type: 'log_visit', people: [{ name: 'Mum', id: 'p-mum' }, { name: 'Dad', id: 'p-dad' }], date: '2026-09-21', place: { name: 'Nopi', id: 'l-nopi' } }, dataOf(), { id: 'v', now: NOW })!
    expect(at).toMatchObject({ title: 'Mum and Dad at Nopi', peopleIds: ['p-mum', 'p-dad'], placeId: 'l-nopi' })
    expect(visitTask({ type: 'log_visit', people: [{ name: 'Mum', id: 'p-mum' }], date: '2026-09-21', note: 'Sunday lunch' }, dataOf(), { id: 'v', now: NOW })!.title).toBe('Sunday lunch')
    // a name still to pick is not a visit yet
    expect(visitTask({ type: 'log_visit', people: [{ name: 'Sarah' }], date: '2026-09-21' }, dataOf(), { id: 'v', now: NOW })).toBeNull()
  })

  it('writes a note as Notes saves one: private, its text as paragraphs and lists', () => {
    const n = noteRecord({ type: 'create_note', title: 'Gift ideas', text: 'For Mum:\n\n- a scarf\n- <tea>' }, { id: 'note~n', now: NOW })!
    expect(n).toMatchObject({ kind: 'note', id: 'note~n', title: 'Gift ideas', body: '<p>For Mum:</p><ul><li>a scarf</li><li>&lt;tea&gt;</li></ul>' })
    expect(n.shared).toBeUndefined()
    expect(noteRecord({ type: 'create_note', title: '', text: 'Just words' }, { id: 'n', now: NOW })!.title).toBe('Untitled note')
  })

  it('makes an event as the event editor does: all day, or an hour from its start', () => {
    const rest = { location: '', notes: '', work: undefined, peopleIds: [] }
    const strip = (e: CalendarEntry) => ({ ...e, id: '', createdAt: '', updatedAt: '' })
    const allDay = eventRecord({ type: 'create_event', title: 'Mum’s birthday', date: '2026-09-27' }, { id: 'event~e', now: NOW })
    expect(strip(allDay)).toEqual(strip(buildEntry(undefined, { title: 'Mum’s birthday', start: '2026-09-27', end: '2026-09-28', allDay: true }, rest, false)))
    const timed = eventRecord({ type: 'create_event', title: 'Dentist', date: '2026-09-25', start: '15:00' }, { id: 'e', now: NOW })
    const start = new Date(2026, 8, 25, 15, 0).toISOString()
    expect(strip(timed)).toEqual(strip(buildEntry(undefined, { title: 'Dentist', start, end: new Date(2026, 8, 25, 16, 0).toISOString(), allDay: false }, rest, false)))
    expect(eventRecord({ type: 'create_event', title: 'Dentist', date: '2026-09-25', start: '15:00', end: '15:30' }, { id: 'e', now: NOW }).end).toBe(new Date(2026, 8, 25, 15, 30).toISOString())
  })
})

/** A planner in memory with the shell's paths, for applying cards to. */
function fakeHost(items: Item[] = [...TASKS, ...PEOPLE, ...RECIPES, ...PLACES], over: Partial<ChatData> = {}) {
  const calls: string[] = []
  const all = [...items]
  const live = <T extends Item>(kind: T['kind']) => all.filter((i): i is T => i.kind === kind && !i.deletedAt)
  const put = (item: Item) => {
    const at = all.findIndex(i => i.id === item.id)
    if (at === -1) all.push(item)
    else all[at] = item
  }
  const host: ChatHost = {
    get people() {
      return live<Person>('person')
    },
    get recipes() {
      return live<Recipe>('recipe')
    },
    get places() {
      return live<Place>('place')
    },
    get tasks() {
      return live<Task>('task')
    },
    get meals() {
      return live<Meal>('meal')
    },
    get mealRows() {
      return all.filter((i): i is Meal => i.kind === 'meal')
    },
    get groceries() {
      return live<GroceryList>('grocery')
    },
    get notes() {
      return live<Note>('note')
    },
    get events() {
      return live<CalendarEntry>('event')
    },
    myId: ME,
    inHousehold: true,
    ...over,
    upsert: item => {
      calls.push(`upsert ${item.kind}`)
      put(item)
    },
    remove: id => {
      calls.push(`remove ${id}`)
      const at = all.findIndex(i => i.id === id)
      if (at >= 0) all[at] = { ...all[at], deletedAt: NOW.toISOString(), updatedAt: new Date(Date.parse(all[at].updatedAt) + 1).toISOString() }
    },
    setStatus: (id: string, status: TaskStatus) => {
      calls.push(`status ${id} ${status}`)
      const prev = all.find((i): i is Task => i.id === id && i.kind === 'task')
      if (!prev || prev.status === status) return null
      const next: Task = { ...prev, status, completedAt: status === 'done' ? NOW.toISOString() : undefined, updatedAt: new Date(Date.parse(prev.updatedAt) + 1000).toISOString() }
      put(next)
      return { prev, next }
    },
    pushToProjectBoard: t => calls.push(`board ${t.id}`),
    saveMeal: m => {
      calls.push(`saveMeal ${m.id}`)
      put(m)
    },
    clearMeal: id => {
      calls.push(`clearMeal ${id}`)
      host.remove(id)
    },
    saveEvents: es => {
      calls.push(`saveEvents ${es.length}`)
      es.forEach(put)
    },
    removeEvent: id => {
      calls.push(`removeEvent ${id}`)
      host.remove(id)
    },
    createRecipe: name => {
      const r = recipe(`r-new-${name}`, name)
      calls.push(`createRecipe ${name}`)
      put(r)
      return r
    },
  }
  return { host, calls, all }
}

const at = { turnId: 'chat~2026-09-23T03:30:00.001Z~abcdefghij', now: NOW, todayKey: '2026-09-22' }

describe('applying a card through the planner’s own paths', () => {
  it('makes a task once, under an id the card owns, and Undo takes it back to the Trash', () => {
    const { host } = fakeHost()
    const a: ChatAction = { type: 'create_task', title: 'Call the plumber', date: '2026-09-25' }
    const done = applyChatAction(host, a, { ...at, index: 0 })!
    const id = chatRecordId('task', at.turnId, 0)
    expect(done.ids).toEqual([id])
    expect(done.said).toBe('Added task “Call the plumber”')
    expect(host.tasks.filter(t => t.id === id)).toHaveLength(1)
    // the same card on another of the person's devices makes no second task
    applyChatAction(host, a, { ...at, index: 0 })
    expect(host.tasks.filter(t => t.id === id)).toHaveLength(1)
    expect(done.undo(host)).toBe(true)
    expect(host.tasks.some(t => t.id === id)).toBe(false)
  })

  it('changes a task’s status through the status path, and Undo puts back what it was — unless it has changed since', () => {
    const { host, calls } = fakeHost()
    const done = applyChatAction(host, { type: 'update_task', taskId: 't-plumber', title: 'Call the plumber', status: 'done', priority: 'high' }, { ...at, index: 1 })!
    expect(calls).toEqual(['status t-plumber done', 'upsert task', 'board t-plumber'])
    expect(host.tasks.find(t => t.id === 't-plumber')).toMatchObject({ status: 'done', priority: 'high' })
    expect(done.undo(host)).toBe(true)
    expect(host.tasks.find(t => t.id === 't-plumber')).toMatchObject({ status: 'todo', priority: 'normal', dueAt: day(9, 24) })

    const again = applyChatAction(host, { type: 'update_task', taskId: 't-plumber', title: '', priority: 'urgent' }, { ...at, index: 1 })!
    const now = host.tasks.find(t => t.id === 't-plumber')!
    host.upsert({ ...now, title: 'Call the plumber back', updatedAt: new Date(Date.parse(now.updatedAt) + 5000).toISOString() })
    expect(again.undo(host)).toBe(false)
    expect(host.tasks.find(t => t.id === 't-plumber')!.title).toBe('Call the plumber back')
  })

  it('adds grocery lines, and Undo takes out what it added and puts back what it changed', () => {
    const week = weekKeyOf('2026-09-22')!
    const list: GroceryList = { kind: 'grocery', id: groceryId(week, ME), weekKey: week, items: [{ id: 'g1', name: 'Milk', state: 'done', recipeIds: [], manual: true }], ownerId: ME, createdAt: STAMP, updatedAt: STAMP }
    const { host } = fakeHost([list])
    const done = applyChatAction(host, { type: 'add_grocery', items: ['milk', 'eggs'] }, { ...at, index: 2 })!
    expect(host.groceries[0].items.map(i => `${i.name}:${i.state}`)).toEqual(['Milk:need', 'eggs:need'])
    expect(done.undo(host)).toBe(true)
    expect(host.groceries[0].items).toEqual(list.items)
  })

  it('plans a new dish as a new recipe, and Undo clears the slot and the recipe nobody filled in', () => {
    const { host, calls } = fakeHost()
    const done = applyChatAction(host, { type: 'plan_meal', date: '2026-09-29', slot: 'dinner', dish: { name: 'Fish pie' }, newDish: true }, { ...at, index: 3 })!
    expect(calls).toEqual(['createRecipe Fish pie', `saveMeal meal~2026-09-29~dinner~${ME}`])
    expect(done.said).toBe('Planned dinner on Tue Sep 29: Fish pie')
    expect(host.meals[0]).toMatchObject({ recipeId: 'r-new-Fish pie', title: 'Fish pie', shared: false })
    expect(done.undo(host)).toBe(true)
    expect(host.meals).toEqual([])
    expect(host.recipes.some(r => r.name === 'Fish pie')).toBe(false)
  })

  it('reuses a recipe of that name rather than making a second one', () => {
    const { host, calls } = fakeHost()
    applyChatAction(host, { type: 'plan_meal', date: '2026-09-29', slot: 'dinner', dish: { name: 'lasagne' }, newDish: true }, { ...at, index: 3 })
    expect(calls).toEqual([`saveMeal meal~2026-09-29~dinner~${ME}`])
    expect(host.meals[0].recipeId).toBe('r-lasagne')
  })

  it('logs a visit, writes a note, and saves an event through the calendar’s own path', () => {
    const { host, calls } = fakeHost()
    applyChatAction(host, { type: 'log_visit', people: [{ name: 'Mum', id: 'p-mum' }], date: '2026-09-21' }, { ...at, index: 4 })
    applyChatAction(host, { type: 'create_note', title: 'Gift ideas', text: 'A scarf' }, { ...at, index: 5 })
    const e = applyChatAction(host, { type: 'create_event', title: 'Dentist', date: '2026-09-25', start: '15:00' }, { ...at, index: 0 })!
    expect(host.tasks.find(t => t.id === chatRecordId('task', at.turnId, 4))).toMatchObject({ title: 'Saw Mum', status: 'done' })
    expect(host.notes[0]).toMatchObject({ id: chatRecordId('note', at.turnId, 5), title: 'Gift ideas' })
    expect(calls).toContain('saveEvents 1')
    e.undo(host)
    expect(calls).toContain(`removeEvent ${chatRecordId('event', at.turnId, 0)}`)
  })

  it('applies nothing while a name is still to pick, or when its task has gone', () => {
    const { host, calls } = fakeHost()
    expect(applyChatAction(host, { type: 'log_visit', people: [{ name: 'Sarah' }], date: '2026-09-21' }, { ...at, index: 0 })).toBeNull()
    expect(applyChatAction(host, { type: 'plan_meal', date: '2026-09-29', slot: 'dinner', dish: { name: 'tacos' } }, { ...at, index: 0 })).toBeNull()
    expect(applyChatAction(host, { type: 'update_task', taskId: 'gone', title: 'x', status: 'done' }, { ...at, index: 0 })).toBeNull()
    expect(calls).toEqual([])
  })
})

describe('a card’s state, read off the thread', () => {
  const answer = newTurn('drafter', 'Here are three.', undefined, new Date('2026-09-23T03:30:00.000Z'), {
    actions: [
      { type: 'add_grocery', items: ['milk'] },
      { type: 'create_note', title: 'Gift ideas', text: '' },
      { type: 'create_task', title: 'Call the plumber' },
    ],
  })!
  const settled = (i: number, index: number, state: 'applied' | 'skipped' | 'undone') =>
    newTurn('drafter', outcomeLine(state, ['x']), undefined, new Date(Date.parse('2026-09-23T03:31:00.000Z') + i), { outcomes: [{ turnId: answer.id, index, state }] })!

  it('takes the latest word on each card, and Undo puts one back to waiting', () => {
    const turns: ChatTurn[] = [answer, settled(1, 0, 'applied'), settled(2, 1, 'skipped'), settled(3, 0, 'undone')]
    const states = outcomesByCard(turns)
    expect([0, 1, 2].map(i => cardState(states.get(cardKey(answer.id, i))))).toEqual(['pending', 'skipped', 'pending'])
    expect(cardState(outcomesByCard([...turns, settled(4, 0, 'applied')]).get(cardKey(answer.id, 0)))).toBe('applied')
  })

  it('says what happened in one short line', () => {
    expect(outcomeLine('applied', ['Added task “Call the plumber”'])).toBe('✓ Added task “Call the plumber”')
    expect(outcomeLine('applied', ['a', 'b'])).toBe('✓ Applied 2: a; b')
    expect(outcomeLine('skipped', ['New task · Call the plumber'])).toBe('Skipped: New task · Call the plumber')
    expect(outcomeLine('undone', ['New task · Call the plumber'])).toBe('↩ Undid: New task · Call the plumber')
  })

  it('never feeds the app’s own lines back to the model as anybody’s words', () => {
    const you = newTurn('you', 'Add milk', undefined, new Date('2026-09-23T03:29:00.000Z'))!
    const lines = recentContext([you, answer, settled(1, 0, 'applied')])
    expect(lines).toEqual(['Them: Add milk', 'You: Here are three.'])
  })

  it('keeps suggestions and outcomes through the sanitizer every copy passes, and an old turn exactly as it was', () => {
    expect(sanitizeItem(answer)).toEqual(answer)
    const line = settled(1, 0, 'applied')
    expect(sanitizeChatTurn({ ...line, outcomes: [{ turnId: answer.id, index: 0, state: 'applied', ids: ['task~a'] }] })!.outcomes).toEqual([{ turnId: answer.id, index: 0, state: 'applied', ids: ['task~a'] }])
    const old = { kind: 'chat', id: 'chat~2026-09-21T09:30:00.000Z~a', role: 'drafter', text: 'You saw Mum on Tuesday', cites: ['T9'], createdAt: STAMP, updatedAt: STAMP }
    expect(sanitizeChatTurn(old)).toEqual({ ...old, ownerId: undefined, deletedAt: undefined, purged: undefined, actions: undefined, outcomes: undefined })
  })

  it('drops a suggestion it cannot read, and never lets a line you typed carry one', () => {
    const t = sanitizeChatTurn({
      ...answer,
      actions: [{ type: 'delete_task', taskId: 't1' }, { type: 'plan_meal', date: '2026-02-30', slot: 'dinner', dish: { name: 'x' } }, { type: 'add_grocery', items: ['milk'] }],
      outcomes: [{ turnId: answer.id, index: 9, state: 'applied' }, { turnId: answer.id, index: 0, state: 'maybe' }],
    })!
    expect(t.actions).toEqual([{ type: 'add_grocery', items: ['milk'] }])
    expect(t.outcomes).toBeUndefined()
    expect(sanitizeChatTurn({ ...answer, role: 'you' })!.actions).toBeUndefined()
  })

  it('offers asks that come back as suggestions among the starters', () => {
    expect(CHAT_PROMPTS).toContain('Add milk and eggs to the grocery list')
    expect(CHAT_PROMPTS).toContain('Plan tacos for Tuesday dinner')
  })
})

describe('a card’s words', () => {
  const d = dataOf()
  const words = (a: ChatAction) => describeAction(a, d, '2026-09-22')

  it('says each suggestion in one line', () => {
    expect(words({ type: 'create_task', title: 'Call the plumber', date: '2026-09-25' }).line).toBe('New task · Call the plumber · due Fri Sep 25')
    expect(words({ type: 'create_task', title: 'Call the plumber', date: '2026-09-25', time: '15:30' }).line).toBe('New task · Call the plumber · due Fri Sep 25 3:30pm')
    expect(words({ type: 'update_task', taskId: 't-plumber', title: 'x', status: 'done' }).line).toBe('Mark done · Call the plumber')
    expect(words({ type: 'update_task', taskId: 't-dentist', title: 'x', date: '2026-09-25' }).line).toBe('Reschedule · Book the dentist · due Fri Sep 25 3pm')
    expect(words({ type: 'add_grocery', items: ['milk', 'eggs'] }).line).toBe('Groceries · milk, eggs')
    expect(words({ type: 'add_grocery', items: ['bread'], date: '2026-09-30' }).line).toBe('Groceries · bread · week of Sun Sep 27')
    expect(words({ type: 'plan_meal', date: '2026-09-22', slot: 'dinner', dish: { name: 'Beef tacos', id: 'r-tacos' } }).line).toBe('Dinner · Tue Sep 22 · Beef tacos')
    expect(words({ type: 'plan_meal', date: '2026-09-22', slot: 'lunch', out: true, place: { name: 'Pret A Manger', id: 'l-pret' } }).line).toBe('Lunch · Tue Sep 22 · Out at Pret A Manger')
    expect(words({ type: 'log_visit', people: [{ name: 'Mum', id: 'p-mum' }, { name: 'Dad', id: 'p-dad' }], date: '2026-09-21', place: { name: 'Nopi', id: 'l-nopi' } }).line).toBe(
      'Visit · Mum and Dad · Mon Sep 21 · at Nopi',
    )
    expect(words({ type: 'create_note', title: 'Gift ideas', text: '' }).line).toBe('New note · Gift ideas')
    expect(words({ type: 'create_event', title: 'Dentist', date: '2026-09-25', start: '15:00', end: '16:30' }).line).toBe('New event · Dentist · Fri Sep 25 · 3pm–4:30pm')
    expect(words({ type: 'create_event', title: 'Mum’s birthday', date: '2026-09-27' }).line).toBe('New event · Mum’s birthday · Sun Sep 27 · all day')
  })

  it('says in its details who can see what it makes', () => {
    expect(words({ type: 'create_task', title: 'x' }).details).toContain('Private until you share it')
    expect(words({ type: 'plan_meal', date: '2026-09-22', slot: 'dinner', dish: { name: 'Lasagne', id: 'r-lasagne' } }).details).toContain('Just you until you share it with the household')
    expect(describeAction({ type: 'create_task', title: 'x' }, dataOf({ inHousehold: false }), '2026-09-22').details).not.toContain('Private until you share it')
  })

  it('blocks a change to a task that has gone', () => {
    expect(words({ type: 'update_task', taskId: 'gone', title: 'Old thing', status: 'done' }).blocked).toBe('That task is no longer in the planner')
  })
})
