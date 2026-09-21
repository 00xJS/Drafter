import { useEffect, useMemo, useRef, useState } from 'react'
import { workDaysOf } from '../../calgrid'
import { newerStamp } from '../../itemops'
import { localDayKey } from '../../journal'
import { shortDay } from '../../kitchen'
import { retireMedia } from '../../media'
import type { CalendarEntry, Garment, Item, Outfit, Wear } from '../../types'
import { lastPlanDay, liveById, logLook, looksOn, outfitLabel, renamed, retired, saveOutfit, starred, swappedPhotos, wearable, wearIndex, type LookLog } from '../../wardrobe'
import { Icon } from '../Icon'
import { WARDROBE_TABS, type WardrobeTab } from '../planner/routes'
import { dayAfterRoll, useDayKey } from '../../useDayKey'
import type { WardrobeOpen } from '../planner/useNavigation'
import { Clothes } from './Clothes'
import { GarmentSheet, type SheetMode } from './GarmentSheet'
import { OutfitComposer } from './OutfitComposer'
import { WardrobeStats } from './WardrobeStats'

interface Props {
  garments: Garment[]
  /** Pieces in Trash: only for a day whose look still holds one, so its row shows it and a log keeps its slot. */
  inTrash?: Garment[]
  outfits: Outfit[]
  wears: Wear[]
  /** The account signed in: a piece's photos are filed under its own personal/ folder. */
  myId?: string | null
  /** Calendar entries: a day with a work-day entry of your own is a work day, and Outfit dresses it for work. */
  entries?: CalendarEntry[]
  onSave(item: Item): void
  onRemove(id: string): void
  onRestore(ids: string[]): void
  showToast(msg: string, undo?: () => void): void
  /** A way in from the Today card, the palette, a link, the Calendar, the Week review or Ask: used once, then forgotten. */
  open: WardrobeOpen | null
  onOpenConsumed(): void
}

/** A day the composer may show: a day key no later than the last a look can be planned for, else today. */
const dayOr = (day: string | undefined, today: string) => (day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= lastPlanDay(today) ? day : today)
const sheetFor = (o: WardrobeOpen | null): SheetMode | null => (o?.add ? { kind: 'add', type: o.add === true ? undefined : o.add } : o?.garmentId ? { kind: 'edit', id: o.garmentId } : null)
/** The pieces of the saved outfit a way in names, for the composer's rows; null when it names none, or that one is gone. */
const outfitFor = (o: WardrobeOpen | null, outfits: readonly Outfit[]): string[] | null => {
  const found = o?.outfitId ? outfits.find(x => x.id === o.outfitId && !x.deletedAt) : undefined
  return found ? [...found.garmentIds] : null
}
const lastOf = <T,>(list: readonly T[]): T | undefined => list[list.length - 1]
const NONE: Garment[] = []
const NO_ENTRIES: CalendarEntry[] = []
/** The piece sheet shows none of today's look, so its Wear today keeps all of it but what the piece replaces. */
const NOTHING_SHOWN: ReadonlySet<string> = new Set()

/**
 * Home → Wardrobe: Outfit (the composer), Clothes (every piece) and Stats,
 * over one wear index worked out per render. It owns the one piece sheet and
 * every write the three make, each with its toast and Undo; nothing here ever
 * rewrites a look or an outfit because a piece changed or went away.
 */
export function Wardrobe({ garments, inTrash = NONE, outfits, wears, myId = null, entries = NO_ENTRIES, onSave, onRemove, onRestore, showToast, open, onOpenConsumed }: Props) {
  // not localDayKey() on its own: nothing re-rendered this at midnight, so an
  // app left open — and on the phone that is every app, since iOS resumes the
  // page rather than killing it — went on dressing yesterday
  const todayKey = useDayKey()
  const workDays = useMemo(() => workDaysOf(entries, myId), [entries, myId])
  const [tab, setTab] = useState<WardrobeTab>(() => open?.tab ?? 'outfit')
  const [day, setDay] = useState(() => dayOr(open?.date, todayKey))
  const [sheet, setSheet] = useState<SheetMode | null>(() => sheetFor(open))
  /** A saved outfit a way in asked for, until the composer has put it in its rows. */
  const [pending, setPending] = useState<string[] | null>(() => outfitFor(open, outfits))
  /** A look of the day, or a new change, from Today; consumed once like pending. */
  const [lookFocus, setLookFocus] = useState<{ wearId?: string; another?: true } | null>(() =>
    open?.wearId ? { wearId: open.wearId } : open?.another ? { another: true } : null,
  )
  const byId = useMemo(() => liveById(garments), [garments])
  /** Every piece this device has, Trash included: a log reads each one's slot here. */
  const records = useMemo(() => [...garments, ...inTrash], [garments, inTrash])
  const ix = useMemo(() => wearIndex(wears, todayKey), [wears, todayKey])

  /**
   * The local day rolled under an open app. A composer sitting on what WAS
   * today follows it to the new one; a day the wearer went to themselves is
   * theirs, and stays. The composer is keyed on the day it is dressing, so
   * the roll remounts it: the rows re-deal by rest, and the new day starts on
   * None instead of carrying what was chosen for yesterday.
   */
  const rolledFrom = useRef(todayKey)
  useEffect(() => {
    if (rolledFrom.current === todayKey) return
    const was = rolledFrom.current
    rolledFrom.current = todayKey
    setDay(d => dayAfterRoll(d, was, todayKey))
  }, [todayKey])

  // a way in is used once — the view, the day, the sheet, an outfit for the
  // rows — and then forgotten, so the next visit opens on today's composer
  useEffect(() => {
    if (!open) return
    if (open.tab) setTab(open.tab)
    else if (open.date || open.outfitId) setTab('outfit')
    if (open.date) setDay(dayOr(open.date, localDayKey()))
    const s = sheetFor(open)
    if (s) setSheet(s)
    const ids = outfitFor(open, outfits)
    if (ids) setPending(ids)
    if (open.wearId) setLookFocus({ wearId: open.wearId })
    else if (open.another) setLookFocus({ another: true })
    onOpenConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /** Write a log and say so; Undo removes a new look, or writes back the copy an edit was made on. */
  const commit = ({ write, undo }: LookLog, msg: string) => {
    onSave(write)
    showToast(msg, () => ('remove' in undo ? onRemove(undo.remove) : onSave(undo)))
  }
  const loggedOn = (d: string) => (d === todayKey ? 'Logged for today' : `Logged for ${shortDay(d, todayKey)}`)
  /**
   * The composer's log: the day's latest look takes the pieces (unless
   * `another`), else a new look does. A day still to come is planned; a plan
   * logged on its day, or after, is confirmed worn.
   */
  const logDay = (d: string, pieces: readonly string[], opts: { shown: ReadonlySet<string>; another?: boolean; note?: string; wearId?: string }) => {
    const planned = d > todayKey
    const was = opts.wearId ? looksOn(wears, d).find(w => w.id === opts.wearId) : lastOf(looksOn(wears, d))
    const log = logLook(wears, d, pieces, records, { ...opts, planned })
    const added = 'remove' in log.undo
    commit(log, planned ? (added ? `Planned for ${shortDay(d, todayKey)}` : 'Plan updated') : added || was?.planned ? loggedOn(d) : 'Look updated')
  }
  const removeLook = (d: string, wearId?: string) => {
    const looks = looksOn(wears, d)
    const target = wearId ? looks.find(w => w.id === wearId) : lastOf(looks)
    if (!target) return
    onRemove(target.id)
    showToast(target.planned ? 'Plan removed' : 'Look removed', () => onRestore([target.id]))
  }
  const saveCombo = (pieces: readonly string[]) => {
    const { outfit, reused } = saveOutfit(outfits, pieces)
    if (reused) {
      showToast(`Already saved as “${outfit.name || outfitLabel(outfit.garmentIds, byId)}”`)
      return
    }
    onSave(outfit)
    showToast('Outfit saved', () => onRemove(outfit.id))
  }

  /** Photos a write of a piece swapped out go once the new ones are up and the server has the write, if nothing points at them by then (media.ts retireMedia). */
  const letGo = (from: Garment, to: Garment) => {
    const { gone, now } = swappedPhotos(from, to)
    if (gone.length) retireMedia(gone, now, to.id)
  }
  /** An edit of a piece; with a message, Undo writes the copy it was made on back, stamped newer again. */
  const editPiece = (before: Garment, after: Garment, msg?: string) => {
    onSave(after)
    letGo(before, after)
    if (msg)
      showToast(msg, () => {
        const back = { ...before, updatedAt: newerStamp(after.updatedAt) }
        onSave(back)
        letGo(after, back)
      })
  }
  const retire = (g: Garment, on: boolean) => editPiece(g, retired(g, on), on ? `Retired ${g.name}` : `${g.name} is back`)
  const removePiece = (g: Garment) => {
    setSheet(null)
    onRemove(g.id)
    showToast(`Deleted ${g.name}`, () => onRestore([g.id]))
  }
  /**
   * The piece sheet's Wear today: into today's latest look, in its own slot, or
   * a look of its own. A plan is said to be worn only where its pieces are on
   * screen — Today's Wore it, the composer — so beside today's plan the piece
   * is a look of its own, as a saved outfit's Wear today is, and the plan
   * stays a plan.
   */
  const wearToday = (g: Garment) => {
    const another = !!lastOf(looksOn(wears, todayKey))?.planned
    const log = logLook(wears, todayKey, [g.id], records, { shown: NOTHING_SHOWN, another })
    commit(log, 'remove' in log.undo ? 'Logged for today' : `${g.name} added to today’s look`)
  }
  /** A saved outfit's Wear today, as a Today chip logs: a look of its own, and only when every piece can be worn. */
  const wearOutfit = (o: Outfit) => {
    if (wearable(o.garmentIds, byId)) commit(logLook(wears, todayKey, o.garmentIds, records, { another: true }), 'Logged for today')
  }
  const goDay = (d: string) => {
    setSheet(null)
    setTab('outfit')
    setDay(dayOr(d, todayKey))
  }
  return (
    <section className="wardrobe">
      <div className="wardrobe-bar">
        <span className="segmented wardrobe-seg" role="tablist" aria-label="Wardrobe view">
          {WARDROBE_TABS.map(t => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'seg on' : 'seg'} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </span>
        <button type="button" className="btn wardrobe-add" onClick={() => setSheet({ kind: 'add' })}>
          <Icon name="camera" size={16} /> Add clothing
        </button>
      </div>

      {tab === 'outfit' && (
        <OutfitComposer
          // a day roll starts the composer over; stepping between days does not
          key={day === todayKey ? todayKey : 'browsing'}
          garments={garments}
          inTrash={inTrash}
          outfits={outfits}
          wears={wears}
          byId={byId}
          ix={ix}
          day={day}
          todayKey={todayKey}
          workDays={workDays}
          onDay={d => setDay(dayOr(d, todayKey))}
          onLog={logDay}
          onRemoveLook={removeLook}
          onSaveOutfit={saveCombo}
          onAdd={type => setSheet({ kind: 'add', type })}
          onOpenPiece={id => setSheet({ kind: 'edit', id })}
          onWearOutfit={wearOutfit}
          onRenameOutfit={(o, name) => onSave(renamed(o, name))}
          onFavouriteOutfit={(o, on) => onSave(starred(o, on))}
          onDeleteOutfit={o => {
            onRemove(o.id)
            showToast('Outfit deleted', () => onRestore([o.id]))
          }}
          pending={pending}
          onPendingUsed={() => setPending(null)}
          focus={lookFocus}
          onFocusConsumed={() => setLookFocus(null)}
        />
      )}
      {tab === 'clothes' && <Clothes garments={garments} ix={ix} onAdd={type => setSheet({ kind: 'add', type })} onOpen={id => setSheet({ kind: 'edit', id })} />}
      {tab === 'stats' && (
        <WardrobeStats
          garments={garments}
          outfits={outfits}
          byId={byId}
          ix={ix}
          onOpenPiece={id => setSheet({ kind: 'edit', id })}
          onRetire={g => retire(g, true)}
          onSaveOutfit={saveCombo}
          onGoDay={goDay}
          onWearToday={wearToday}
        />
      )}

      {sheet && (
        <GarmentSheet
          key={sheet.kind === 'edit' ? sheet.id : 'add'}
          mode={sheet}
          garments={garments}
          outfits={outfits}
          byId={byId}
          ix={ix}
          todayKey={todayKey}
          userId={myId}
          onCreate={g => {
            onSave(g)
            showToast(`Added ${g.name}`, () => onRemove(g.id))
          }}
          onEdit={editPiece}
          onRetire={retire}
          onDelete={removePiece}
          onWearToday={wearToday}
          onGoDay={goDay}
          onOpenPiece={id => setSheet({ kind: 'edit', id })}
          onClose={() => setSheet(null)}
        />
      )}
    </section>
  )
}
