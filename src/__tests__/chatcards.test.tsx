import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it } from 'vitest'
import { newTurn, thread } from '../chat'
import { cardKey, chatRecordId, outcomeLine, taskPreset, type ChatData } from '../chatactions'
import type { AskSources } from '../ask'
import { Chat } from '../components/Chat'
import { ActionCards, type CardHandlers } from '../components/ChatCards'
import { TaskEditor } from '../components/TaskEditor'
import type { ChatAction, ChatOutcome, ChatTurn, Person, Place, Recipe, Task } from '../types'

// The cards under an answer, as a first render draws them: one line each,
// Apply · Edit · Skip, Apply all when more than one is waiting, a picker for a
// name nothing matched, and what an applied or skipped card says instead. What
// the buttons do is in chatactions.test.ts; this is what they look like.

const zone = process.env.TZ
process.env.TZ = 'America/Phoenix'
afterAll(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

const STAMP = '2026-09-01T12:00:00.000Z'
const TODAY = '2026-09-22'
const noop = () => {}
const person = (id: string, name: string): Person => ({ kind: 'person', id, name, color: '#f97316', group: 'family', createdAt: STAMP, updatedAt: STAMP })
const PEOPLE = [person('p-mum', 'Mum'), person('p-sarah', 'Sarah Jones'), person('p-sarah2', 'Sarah Lee')]
const RECIPES: Recipe[] = [{ kind: 'recipe', id: 'r-tacos', name: 'Beef tacos', ingredients: [], tags: [], createdAt: STAMP, updatedAt: STAMP }]
const PLACES: Place[] = [{ kind: 'place', id: 'l-nopi', name: 'Nopi', color: '#f97316', category: 'restaurant', createdAt: STAMP, updatedAt: STAMP }]
const DATA: ChatData = { people: PEOPLE, recipes: RECIPES, places: PLACES, tasks: [], meals: [], mealRows: [], groceries: [], notes: [], events: [], myId: null, inHousehold: true }

const handlers = (over: Partial<CardHandlers> = {}): CardHandlers => ({
  apply: noop,
  skip: noop,
  undo: noop,
  canUndo: () => false,
  edit: noop,
  saveNote: noop,
  open: noop,
  savePerson: noop,
  savePlace: noop,
  createPlace: (name, category) => ({ kind: 'place', id: 'new', name, category, color: '#f97316', createdAt: STAMP, updatedAt: STAMP }),
  createRecipe: name => ({ kind: 'recipe', id: 'new', name, ingredients: [], tags: [], createdAt: STAMP, updatedAt: STAMP }),
  ...over,
})

const answer = (actions: ChatAction[]) => newTurn('drafter', 'Here is what I would do.', undefined, new Date('2026-09-23T03:30:00.000Z'), { actions })!
/** The cards for a turn; `null` for no handlers at all. */
const cards = (turn: ChatTurn, outcomes: Map<string, ChatOutcome> = new Map(), on: CardHandlers | null = handlers()) =>
  renderToStaticMarkup(<ActionCards turn={turn} outcomes={outcomes} data={DATA} todayKey={TODAY} on={on ?? undefined} />)
/** Every button's label, in order, with whether it can be pressed. */
const buttons = (html: string) => [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(m => `${m[2].replace(/<[^>]+>/g, '')}${/ disabled=""/.test(m[1]) ? ' (off)' : ''}`)

const TASK: ChatAction = { type: 'create_task', title: 'Call the plumber', date: '2026-09-25' }
const GROCERY: ChatAction = { type: 'add_grocery', items: ['milk', 'eggs'] }

describe('the cards under an answer', () => {
  it('says each suggestion in one line, with Apply · Edit · Skip, and Apply all for more than one', () => {
    const html = cards(answer([TASK, GROCERY]))
    expect(html).toContain('<strong>New task</strong> · Call the plumber · due Fri Sep 25')
    expect(html).toContain('<strong>Groceries</strong> · milk, eggs')
    expect(buttons(html)).toEqual(['New task · Call the plumber · due Fri Sep 25', 'Apply', 'Edit', 'Skip', 'Groceries · milk, eggs', 'Apply', 'Edit', 'Skip', 'Apply all (2)'])
    // the details open on a tap, not before
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('chat-card-details')
  })

  it('has no Apply all for one card', () => {
    expect(buttons(cards(answer([TASK])))).not.toContain('Apply all (1)')
  })

  it('holds Apply on a card whose name nothing matched, and offers who it could be first', () => {
    const turn = answer([TASK, { type: 'log_visit', people: [{ name: 'Sarah' }], date: '2026-09-21' }])
    const html = cards(turn)
    expect(html).toContain('Who is “Sarah”?')
    const options = [...html.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map(m => m[1])
    expect(options.slice(0, 3)).toEqual(['Pick someone…', 'Sarah Jones', 'Sarah Lee'])
    expect(buttons(html)).toEqual(['New task · Call the plumber · due Fri Sep 25', 'Apply', 'Edit', 'Skip', 'Visit · Sarah? · Mon Sep 21', 'Leave out', 'Apply (off)', 'Edit', 'Skip'])
  })

  it('offers a new recipe for a dish that is not one, and no saved place for a meal out', () => {
    const html = cards(answer([{ type: 'plan_meal', date: '2026-09-29', slot: 'dinner', dish: { name: 'Fish pie' } }, { type: 'plan_meal', date: '2026-09-30', slot: 'lunch', out: true, place: { name: 'Taco Bell' } }]))
    expect(html).toContain('“Fish pie” isn’t one of your recipes.')
    expect(html).toContain('“Taco Bell” isn’t one of your places.')
    expect(buttons(html)).toContain('New recipe')
    expect(buttons(html)).toContain('No saved place')
  })

  it('says what became of a card, read from the thread', () => {
    const turn = answer([TASK, GROCERY, { type: 'create_note', title: 'Gift ideas', text: '' }])
    const outcomes = new Map<string, ChatOutcome>([
      [cardKey(turn.id, 0), { turnId: turn.id, index: 0, state: 'applied', ids: [chatRecordId('task', turn.id, 0)] }],
      [cardKey(turn.id, 1), { turnId: turn.id, index: 1, state: 'skipped' }],
      [cardKey(turn.id, 2), { turnId: turn.id, index: 2, state: 'undone' }],
    ])
    // after a reload the page has nothing left to undo an apply with: the card says so and opens what it made
    expect(buttons(cards(turn, outcomes))).toEqual([
      'New task · Call the plumber · due Fri Sep 25',
      'Open',
      'Groceries · milk, eggs',
      'Undo',
      'New note · Gift ideas',
      'Apply',
      'Edit',
      'Skip',
    ])
    const html = cards(turn, outcomes, handlers({ canUndo: i => i === 0 }))
    expect(html).toContain('✓ Applied')
    expect(html).toContain('Skipped')
    expect(buttons(html).slice(0, 3)).toEqual(['New task · Call the plumber · due Fri Sep 25', 'Undo', 'Open'])
  })

  it('shows the cards and lets nothing be pressed when there is nowhere to apply them', () => {
    const labels = buttons(cards(answer([TASK, GROCERY]), new Map(), null))
    expect(labels).toEqual(['New task · Call the plumber · due Fri Sep 25', 'Apply (off)', 'Edit (off)', 'Skip (off)', 'Groceries · milk, eggs', 'Apply (off)', 'Edit (off)', 'Skip (off)', 'Apply all (2) (off)'])
  })

  it('opens the task editor on the suggestion as it stands, private', () => {
    const html = renderToStaticMarkup(
      <TaskEditor
        preset={taskPreset({ type: 'create_task', title: 'Call the plumber', date: '2026-09-25' }, 'task~chat~x~0')}
        projects={[]}
        people={PEOPLE}
        members={[
          { id: 'me', displayName: 'Joseph' },
          { id: 'her', displayName: 'Maria' },
        ]}
        myId="me"
        candidates={[] as Task[]}
        getLatest={() => undefined}
        onSave={noop}
        onCommit={noop}
        onDelete={noop}
        onClose={noop}
      />,
    )
    expect(html).toContain('value="Call the plumber"')
    expect(html).toContain('value="2026-09-25T00:00"')
    expect(html).toContain('Only you can see this task')
  })
})

describe('the assistant’s thread', () => {
  const sources: AskSources = { tasks: [], projects: [], people: PEOPLE, places: PLACES, recipes: RECIPES, meals: [], entries: [], feedEvents: [], journal: [] }
  const chat = (turns: ChatTurn[]) =>
    renderToStaticMarkup(
      <Chat
        side="assistant"
        onSide={noop}
        messages={[]}
        turns={turns}
        household={null}
        myId={null}
        sources={sources}
        tz="America/Phoenix"
        onSendMessage={noop}
        onRemoveMessage={noop}
        onWriteTurn={noop}
        onClearChat={noop}
        onOpen={noop}
        now={new Date('2026-09-23T03:30:00.000Z')}
      />,
    )

  it('says what it can do now, and offers asks that come back as suggestions', () => {
    const html = chat([])
    expect(html).toContain('It can suggest changes — nothing happens until you tap Apply.')
    expect(html).toContain('Only you can read this. Nothing changes until you tap Apply.')
    expect(html).toContain('Add milk and eggs to the grocery list')
    expect(html).toContain('Plan tacos for Tuesday dinner')
  })

  it('draws an old answer exactly as before, cards under a new one, and the app’s own lines quietly', () => {
    const old: ChatTurn = { kind: 'chat', id: 'chat~2026-09-22T16:00:00.000Z~a', role: 'drafter', text: 'Three things are due this week.', createdAt: '2026-09-22T16:00:00.000Z', updatedAt: '2026-09-22T16:00:00.000Z' }
    const asked = newTurn('you', 'Add milk', undefined, new Date('2026-09-23T03:29:00.000Z'))!
    const withCards = answer([GROCERY])
    const settled = newTurn('drafter', outcomeLine('applied', ['Added milk and eggs to the grocery list']), undefined, new Date('2026-09-23T03:31:00.000Z'), {
      outcomes: [{ turnId: withCards.id, index: 0, state: 'applied', ids: ['grocery~2026-W39'] }],
    })!
    const html = chat([old, asked, withCards, settled])
    expect(html).toContain('<li class="chat-line theirs drafter"><span class="chat-who">✈ Drafter</span><span class="chat-bubble">Three things are due this week.</span></li>')
    expect(html).toContain('class="chat-line theirs drafter has-cards"')
    expect(html.match(/class="chat-card /g)).toHaveLength(1)
    expect(html).toContain('<li class="chat-line theirs chat-outcome"><span class="chat-outcome-text">✓ Added milk and eggs to the grocery list</span></li>')
    expect(html).toContain('✓ Applied')
  })
})

describe('a thread’s days are the reader’s', () => {
  it('heads a Phoenix evening with its own day, not UTC’s tomorrow', () => {
    // 18:15 on Tuesday in Phoenix is 01:15 on Wednesday in UTC
    const evening = newTurn('you', 'Add milk', undefined, new Date('2026-09-23T01:15:00.000Z'))!
    const morning = newTurn('you', 'And eggs', undefined, new Date('2026-09-23T15:00:00.000Z'))!
    expect(thread([evening, morning], t => t.role).filter(r => 'day' in r)).toEqual([{ day: '2026-09-22' }, { day: '2026-09-23' }])
  })
})
