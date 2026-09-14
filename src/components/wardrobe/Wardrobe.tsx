import { useEffect, useMemo, useState } from 'react'
import { newerStamp } from '../../itemops'
import { localDayKey } from '../../journal'
import { shortDay } from '../../kitchen'
import { retireMedia } from '../../media'
import type { Garment, Item, Outfit, Wear } from '../../types'
import { liveById, logLook, looksOn, outfitLabel, renamed, retired, saveOutfit, swappedPhotos, wearable, wearIndex, type LookLog } from '../../wardrobe'
import { Icon } from '../Icon'
import { WARDROBE_TABS, type WardrobeTab } from '../planner/routes'
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
  onSave(item: Item): void
  onRemove(id: string): void
  onRestore(ids: string[]): void
  showToast(msg: string, undo?: () => void): void
  /** A way in from the Today card, the palette or a link: used once, then forgotten. */
  open: WardrobeOpen | null
  onOpenConsumed(): void
}

/** A day the composer may show: a day key no later than today, else today. */
const dayOr = (day: string | undefined, today: string) => (day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= today ? day : today)
const sheetFor = (o: WardrobeOpen | null): SheetMode | null => (o?.add ? { kind: 'add', type: o.add === true ? undefined : o.add } : o?.garmentId ? { kind: 'edit', id: o.garmentId } : null)
const lastOf = <T,>(list: readonly T[]): T | undefined => list[list.length - 1]
const NONE: Garment[] = []
/** The piece sheet shows none of today's look, so its Wear today keeps all of it but what the piece replaces. */
const NOTHING_SHOWN: ReadonlySet<string> = new Set()

/**
 * Home → Wardrobe: Outfit (the composer), Clothes (every piece) and Stats,
 * over one wear index worked out per render. It owns the one piece sheet and
 * every write the three make, each with its toast and Undo; nothing here ever
 * rewrites a look or an outfit because a piece changed or went away.
 */
export function Wardrobe({ garments, inTrash = NONE, outfits, wears, myId = null, onSave, onRemove, onRestore, showToast, open, onOpenConsumed }: Props) {
  const todayKey = localDayKey()
  const [tab, setTab] = useState<WardrobeTab>(() => open?.tab ?? 'outfit')
  const [day, setDay] = useState(() => dayOr(open?.date, todayKey))
  const [sheet, setSheet] = useState<SheetMode | null>(() => sheetFor(open))
  const byId = useMemo(() => liveById(garments), [garments])
  /** Every piece this device has, Trash included: a log reads each one's slot here. */
  const records = useMemo(() => [...garments, ...inTrash], [garments, inTrash])
  const ix = useMemo(() => wearIndex(wears, todayKey), [wears, todayKey])

  // a way in is used once — the view, the day, the sheet — and then forgotten,
  // so the next visit opens on today's composer
  useEffect(() => {
    if (!open) return
    if (open.tab) setTab(open.tab)
    else if (open.date) setTab('outfit')
    if (open.date) setDay(dayOr(open.date, localDayKey()))
    const s = sheetFor(open)
    if (s) setSheet(s)
    onOpenConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /** Write a log and say so; Undo removes a new look, or writes back the copy an edit was made on. */
  const commit = ({ write, undo }: LookLog, msg: string) => {
    onSave(write)
    showToast(msg, () => ('remove' in undo ? onRemove(undo.remove) : onSave(undo)))
  }
  const loggedOn = (d: string) => (d === todayKey ? 'Logged for today' : `Logged for ${shortDay(d, todayKey)}`)
  /** The composer's log: the day's latest look takes the pieces (unless `another`), else a new look does. */
  const logDay = (d: string, pieces: readonly string[], opts: { shown: ReadonlySet<string>; another?: boolean }) => {
    const log = logLook(wears, d, pieces, records, opts)
    commit(log, 'remove' in log.undo ? loggedOn(d) : 'Look updated')
  }
  const removeLook = (d: string) => {
    const latest = lastOf(looksOn(wears, d))
    if (!latest) return
    onRemove(latest.id)
    showToast('Look removed', () => onRestore([latest.id]))
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
  /** The piece sheet's Wear today: into today's latest look, in its own slot, or a look of its own. */
  const wearToday = (g: Garment) => {
    const log = logLook(wears, todayKey, [g.id], records, { shown: NOTHING_SHOWN })
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
          garments={garments}
          inTrash={inTrash}
          outfits={outfits}
          wears={wears}
          byId={byId}
          ix={ix}
          day={day}
          todayKey={todayKey}
          onDay={d => setDay(dayOr(d, todayKey))}
          onLog={logDay}
          onRemoveLook={removeLook}
          onSaveOutfit={saveCombo}
          onAdd={type => setSheet({ kind: 'add', type })}
          onOpenPiece={id => setSheet({ kind: 'edit', id })}
          onWearOutfit={wearOutfit}
          onRenameOutfit={(o, name) => onSave(renamed(o, name))}
          onDeleteOutfit={o => {
            onRemove(o.id)
            showToast('Outfit deleted', () => onRestore([o.id]))
          }}
        />
      )}
      {tab === 'clothes' && <Clothes garments={garments} ix={ix} onAdd={type => setSheet({ kind: 'add', type })} onOpen={id => setSheet({ kind: 'edit', id })} />}
      {tab === 'stats' && (
        <WardrobeStats garments={garments} outfits={outfits} byId={byId} ix={ix} onOpenPiece={id => setSheet({ kind: 'edit', id })} onRetire={g => retire(g, true)} onSaveOutfit={saveCombo} />
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
          onClose={() => setSheet(null)}
        />
      )}
    </section>
  )
}
