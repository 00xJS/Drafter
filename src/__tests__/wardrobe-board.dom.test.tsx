// @vitest-environment happy-dom
import { act, fireEvent, render, screen, within } from './dom'
import { useState, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// the photos: none of these pieces has one, and nothing here reaches the device's store
vi.mock('../media', async importOriginal => ({ ...(await importOriginal<typeof import('../media')>()), mediaURL: async () => null, retireMedia: () => {} }))
vi.mock('../cutout', () => ({ isCutOutPhoto: async () => false, cutoutAvailability: async () => 'web', prepareGarmentCutout: async () => {} }))

import { OutfitComposer } from '../components/wardrobe/OutfitComposer'
import { Wardrobe } from '../components/wardrobe/Wardrobe'
import type { CalendarEntry, Garment, GarmentType, Item, Wear } from '../types'
import { liveById, wearIndex } from '../wardrobe'

// The Outfit board as a thumb uses it: a day chosen on the week strip, a piece
// chosen through its slot's picker, Wearing this, an idea put on the card,
// and Plan the week — with what each writes, or does not. The rules under it
// are in wardrobe-board.test.ts; this is the board holding to them.

const T0 = '2026-08-01T09:00:00.000Z'
/** A Monday. */
const TODAY = '2026-09-14'
const piece = (id: string, type: GarmentType, over: Partial<Garment> = {}): Garment => ({ kind: 'garment', id, name: id, type, createdAt: T0, updatedAt: T0, ...over })
let made = 0
const look = (date: string, garmentIds: string[], over: Partial<Wear> = {}): Wear => {
  made++
  return { kind: 'wear', id: `wear~${date}~${String(made).padStart(10, '0')}`, date, garmentIds, createdAt: `${date}T08:00:00.000Z`, updatedAt: `${date}T08:00:00.000Z`, ...over }
}
/** Monday to Friday of this week: your work days. */
const WORK_DAYS: ReadonlySet<string> = new Set(['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'])
/** Your work days, as the Calendar has them. */
const workWeek: CalendarEntry[] = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'].map(d => {
  const [y, m, day] = d.split('-').map(Number)
  return { kind: 'event', id: `work-${d}`, title: 'In the office', start: new Date(y, m - 1, day, 9).toISOString(), end: new Date(y, m - 1, day, 17).toISOString(), allDay: false, work: 'office', createdAt: T0, updatedAt: T0 }
})

const tops = [piece('navy-tee', 'top'), piece('white-shirt', 'top', { occasion: 'work' }), piece('gym-top', 'top', { occasion: 'personal' }), piece('band-tee', 'top', { favourite: true })]
const bottoms = [piece('jeans', 'bottom'), piece('slacks', 'bottom', { occasion: 'work' }), piece('joggers', 'bottom', { occasion: 'personal' })]
const garments = [...tops, ...bottoms]
const history = [look('2026-09-11', ['navy-tee', 'jeans']), look('2026-09-01', ['white-shirt', 'slacks'])]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 14, 10))
})
afterEach(() => {
  vi.useRealTimers()
})

/** Keep → Wardrobe over a store of its own: what it saves lands, what it removes goes, and each toast is kept with its Undo. */
function openWardrobe(wears: Wear[] = history) {
  const toasts: { msg: string; undo?: () => void }[] = []
  const saved: Item[] = []
  function Shell() {
    const [items, setItems] = useState<Item[]>(() => [...garments, ...wears])
    return (
      <Wardrobe
        garments={items.filter((i): i is Garment => i.kind === 'garment')}
        outfits={[]}
        wears={items.filter((i): i is Wear => i.kind === 'wear' && !i.deletedAt)}
        entries={workWeek}
        onSave={item => {
          saved.push(item)
          setItems(list => [...list.filter(x => x.id !== item.id), item])
        }}
        onRemove={id => setItems(list => list.map(x => (x.id === id ? { ...x, deletedAt: '2026-09-14T17:00:00.000Z' } : x)))}
        onRestore={() => {}}
        showToast={(msg, undo) => void toasts.push({ msg, undo })}
        open={null}
        onOpenConsumed={() => {}}
      />
    )
  }
  render(<Shell />)
  return { toasts, saved }
}

const day = (name: RegExp) => within(screen.getByRole('group', { name: 'Days of the week' })).getByRole('button', { name })
/** The picker's tiles, in the order they stand, by their names. */
const tiles = (dialog: HTMLElement) =>
  Array.from(dialog.querySelectorAll<HTMLElement>('.pick-tile, .pick-group'))
    .map(el => (el.classList.contains('pick-group') ? `— ${el.textContent}` : el.querySelector('.pick-name')?.textContent ?? ''))
    .filter(Boolean)
/** The pieces on the card, slot by slot. */
const onCard = () => Array.from(document.querySelectorAll<HTMLElement>('.look-slot-name')).map(el => el.textContent?.replace(/^Favourite: /, ''))

describe('dressing a day through the picker', () => {
  it('opens a top’s picker from its empty slot, takes the tile tapped, and Wearing this logs the look with a dot on today', () => {
    const { toasts, saved } = openWardrobe()
    expect(day(/^Mon 14 Sep, today$/).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Add a top' }))
    const picker = screen.getByRole('dialog', { name: 'Choose a top' })
    // For work: the day's pieces and those for any time, longest rested first — the never worn A–Z — then the rest by rest
    expect(tiles(picker)).toEqual(['None', 'band-tee', 'white-shirt', 'navy-tee', 'Add a top'])
    expect(within(picker).getByRole('button', { name: '1 more for days off · Show all' })).toBeTruthy()
    fireEvent.click(within(picker).getByRole('button', { name: /^white-shirt/ }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add a bottom' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose a bottom' })).getByRole('button', { name: /^slacks/ }))
    expect(onCard()).toEqual(['white-shirt', 'slacks'])
    // nothing was written until now
    expect(saved).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Wearing this' }))
    expect(saved).toEqual([expect.objectContaining({ kind: 'wear', date: TODAY, garmentIds: ['white-shirt', 'slacks'] })])
    expect(toasts.map(t => t.msg)).toEqual(['Logged for today'])
    expect(day(/^Mon 14 Sep, today: a look worn$/)).toBeTruthy()
    expect(document.querySelector('.wardrobe-week-day.today .wardrobe-week-mark')?.classList.contains('logged')).toBe(true)
    expect(screen.getByRole('button', { name: 'Update look' })).toBeTruthy()
  })

  it('ticks the piece a slot holds, empties the slot with None or its ✕, and leaves the card alone on a close', () => {
    openWardrobe([...history, look(TODAY, ['navy-tee', 'jeans'])])
    expect(onCard()).toEqual(['navy-tee', 'jeans'])
    fireEvent.click(screen.getByRole('button', { name: 'Top: navy-tee. Choose another' }))
    const picker = screen.getByRole('dialog', { name: 'Choose a top' })
    expect(within(picker).getByRole('button', { name: /^navy-tee/ }).getAttribute('aria-pressed')).toBe('true')
    expect(within(picker).getByRole('button', { name: 'None' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(within(picker).getByRole('button', { name: 'Close' }))
    expect(onCard()).toEqual(['navy-tee', 'jeans'])
    fireEvent.click(screen.getByRole('button', { name: 'Top: navy-tee. Choose another' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose a top' })).getByRole('button', { name: 'None' }))
    expect(onCard()).toEqual(['jeans'])
    expect(screen.getByRole('button', { name: 'Add a top' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Take off jeans' }))
    expect(onCard()).toEqual([])
    expect((screen.getByRole('button', { name: 'Update look' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('opens on All when the slot holds a piece for the other occasion, so its tick is on screen', () => {
    openWardrobe([...history, look(TODAY, ['gym-top', 'jeans'])])
    fireEvent.click(screen.getByRole('button', { name: 'Top: gym-top. Choose another' }))
    const picker = screen.getByRole('dialog', { name: 'Choose a top' })
    expect(within(picker).getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(picker).getByRole('button', { name: /^gym-top/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('shows All with the others under Other days, the favourites, and a search, in the order it opened with', () => {
    openWardrobe()
    fireEvent.click(screen.getByRole('button', { name: 'Add a top' }))
    const picker = screen.getByRole('dialog', { name: 'Choose a top' })
    fireEvent.click(within(picker).getByRole('button', { name: 'All' }))
    expect(tiles(picker)).toEqual(['None', 'band-tee', 'white-shirt', 'navy-tee', '— Other days', 'gym-top', 'Add a top'])
    fireEvent.click(within(picker).getByRole('button', { name: 'Favourites' }))
    expect(tiles(picker)).toEqual(['None', 'band-tee', 'Add a top'])
    fireEvent.click(within(picker).getByRole('button', { name: 'All' }))
    fireEvent.change(within(picker).getByRole('searchbox', { name: 'Search tops' }), { target: { value: 'TEE' } })
    expect(tiles(picker)).toEqual(['None', 'band-tee', 'navy-tee', 'Add a top'])
  })

  it('never re-sorts under a thumb: a look logged while the picker is open leaves its order as it opened', () => {
    const noop = () => {}
    const props = (wears: Wear[]): ComponentProps<typeof OutfitComposer> => ({
      garments,
      outfits: [],
      wears,
      byId: liveById(garments),
      ix: wearIndex(wears, TODAY),
      day: TODAY,
      todayKey: TODAY,
      workDays: WORK_DAYS,
      onDay: noop,
      onLog: noop,
      onRemoveLook: noop,
      onPlanWeek: noop,
      onSaveOutfit: noop,
      onAdd: noop,
      onOpenPiece: noop,
      onWearOutfit: noop,
      onRenameOutfit: noop,
      onFavouriteOutfit: noop,
      onDeleteOutfit: noop,
      forecast: null,
    })
    const view = render(<OutfitComposer {...props(history)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add a top' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose a top' })).getByRole('button', { name: 'All' }))
    const before = tiles(screen.getByRole('dialog', { name: 'Choose a top' }))
    // another device logs the band tee for yesterday: by rest it would go to the back
    view.rerender(<OutfitComposer {...props([...history, look('2026-09-13', ['band-tee', 'jeans'])])} />)
    expect(tiles(screen.getByRole('dialog', { name: 'Choose a top' }))).toEqual(before)
    // opened again, it is sorted afresh
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose a top' })).getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add a top' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose a top' })).getByRole('button', { name: 'All' }))
    expect(tiles(screen.getByRole('dialog', { name: 'Choose a top' }))).toEqual(['None', 'white-shirt', 'navy-tee', 'band-tee', '— Other days', 'gym-top', 'Add a top'])
  })

  it('hands + Add a top to Add clothing, typed as a top', () => {
    const onAdd = vi.fn()
    const noop = () => {}
    render(
      <OutfitComposer
        garments={garments}
        outfits={[]}
        wears={history}
        byId={liveById(garments)}
        ix={wearIndex(history, TODAY)}
        day={TODAY}
        todayKey={TODAY}
        workDays={WORK_DAYS}
        onDay={noop}
        onLog={noop}
        onRemoveLook={noop}
        onPlanWeek={noop}
        onSaveOutfit={noop}
        onAdd={onAdd}
        onOpenPiece={noop}
        onWearOutfit={noop}
        onRenameOutfit={noop}
        onFavouriteOutfit={noop}
        onDeleteOutfit={noop}
        forecast={null}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add a top' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose a top' })).getByRole('button', { name: 'Add a top' }))
    expect(onAdd).toHaveBeenCalledWith('top')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('the week and the day', () => {
  it('dresses the day tapped, and moves a week either way with the arrows', () => {
    openWardrobe()
    fireEvent.click(day(/^Wed 16 Sep$/))
    expect(screen.getByRole('heading', { name: 'Wed 16 Sep' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Plan for Wed 16 Sep' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'The week after' }))
    expect(screen.getByRole('heading', { name: 'Wed 23 Sep' })).toBeTruthy()
    expect(screen.getByText('20 – 26 Sep')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'The week before' }))
    fireEvent.click(screen.getByRole('button', { name: 'The week before' }))
    expect(screen.getByRole('heading', { name: 'Wed 9 Sep' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/^Day: /), { target: { value: TODAY } })
    expect(screen.getByRole('heading', { name: 'Today · Mon 14 Sep' })).toBeTruthy()
  })

  it('turns a work day into a day off for the visit, and the picker follows it', () => {
    openWardrobe()
    fireEvent.click(screen.getByRole('button', { name: 'Work day: dress for a day off instead' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add a top' }))
    const picker = screen.getByRole('dialog', { name: 'Choose a top' })
    expect(within(picker).getByRole('button', { name: 'For days off' }).getAttribute('aria-pressed')).toBe('true')
    expect(tiles(picker)).toEqual(['None', 'band-tee', 'gym-top', 'navy-tee', 'Add a top'])
  })

  it('keeps a note behind Add a note, and logs what is typed there', () => {
    const { saved } = openWardrobe()
    expect(screen.queryByRole('textbox', { name: 'Note on the look' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add a note' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Note on the look' }), { target: { value: 'interview' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add a top' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose a top' })).getByRole('button', { name: /^white-shirt/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add a bottom' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose a bottom' })).getByRole('button', { name: /^slacks/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Wearing this' }))
    expect(saved[0]).toMatchObject({ note: 'interview', garmentIds: ['white-shirt', 'slacks'] })
  })
})

describe('ideas for the day', () => {
  it('puts an idea on the card with a tap, writing nothing, and New ideas deals others', () => {
    const { saved, toasts } = openWardrobe()
    const ideas = () => Array.from(document.querySelectorAll<HTMLElement>('.idea-tile')).map(el => el.getAttribute('aria-label'))
    const first = ideas()
    expect(first.length).toBeGreaterThan(0)
    // a work day: nothing for days off
    expect(first.join(' ')).not.toMatch(/gym-top|joggers/)
    fireEvent.click(document.querySelector<HTMLElement>('.idea-tile')!)
    const tried = first[0]!.replace(/^Try /, '').split(' + ')
    expect(onCard()).toEqual(tried)
    expect(saved).toEqual([])
    expect(toasts).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'New ideas' }))
    expect(ideas()).not.toEqual(first)
  })
})

describe('plan the week', () => {
  it('plans the days left with no look as one batch, each dealt again or skipped, and one Undo takes the lot back', () => {
    const { toasts, saved } = openWardrobe([...history, look(TODAY, ['navy-tee', 'jeans'])])
    fireEvent.click(screen.getByRole('button', { name: 'Plan the week' }))
    const sheet = screen.getByRole('dialog', { name: 'Plan the week' })
    // today has its look: from tomorrow to Saturday
    const boxes = within(sheet).getAllByRole('checkbox')
    expect(boxes.map(b => b.getAttribute('aria-label'))).toEqual(['Plan Tue 15 Sep', 'Plan Wed 16 Sep', 'Plan Thu 17 Sep', 'Plan Fri 18 Sep', 'Plan Sat 19 Sep'])
    expect(within(sheet).getByText('13 – 19 Sep · 5 days without a look')).toBeTruthy()
    // Saturday is a day off: its look keeps to it
    const saturday = boxes[4].closest('li')!
    expect(saturday.textContent).toContain('Sat 19 Sep · Day off')
    expect(saturday.textContent).not.toMatch(/white-shirt|slacks/)
    // Tuesday's look again: another one, and the others as they were
    const whatOf = (li: Element) => li.querySelector('.plan-week-what')!.textContent
    const tuesday = boxes[0].closest('li')!
    const others = boxes.slice(1).map(b => whatOf(b.closest('li')!))
    const was = whatOf(tuesday)
    fireEvent.click(within(sheet).getByRole('button', { name: 'Another look for Tue 15 Sep' }))
    expect(whatOf(tuesday)).not.toBe(was)
    expect(boxes.slice(1).map(b => whatOf(b.closest('li')!))).toEqual(others)
    // Thursday skipped
    fireEvent.click(boxes[2])
    expect(whatOf(boxes[2].closest('li')!)).toBe('Skipped')
    expect(saved).toEqual([])
    fireEvent.click(within(sheet).getByRole('button', { name: 'Plan 4 days' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(saved.map(w => (w as Wear).date)).toEqual(['2026-09-15', '2026-09-16', '2026-09-18', '2026-09-19'])
    expect(saved.every(w => (w as Wear).planned === true)).toBe(true)
    expect(toasts.map(t => t.msg)).toEqual(['Planned 4 days'])
    for (const d of [/^Tue 15 Sep: a look planned$/, /^Wed 16 Sep: a look planned$/, /^Fri 18 Sep: a look planned$/, /^Sat 19 Sep: a look planned$/]) expect(day(d)).toBeTruthy()
    expect(day(/^Thu 17 Sep$/)).toBeTruthy()
    act(() => toasts[0].undo!())
    for (const d of [/^Tue 15 Sep$/, /^Wed 16 Sep$/, /^Fri 18 Sep$/, /^Sat 19 Sep$/]) expect(day(d)).toBeTruthy()
    // with every day left planned, there is nothing more to plan
    fireEvent.click(screen.getByRole('button', { name: 'Plan the week' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Plan the week' })).getByRole('button', { name: 'Plan 5 days' }))
    expect((screen.getByRole('button', { name: 'Plan the week' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
