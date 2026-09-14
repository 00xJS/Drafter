import { useEffect, useMemo, useState } from 'react'
import { newerStamp } from '../../itemops'
import { localDayKey } from '../../journal'
import { shortDay } from '../../kitchen'
import type { Garment, Item, Outfit, Wear } from '../../types'
import { liveById, looksOn, newWear, outfitLabel, renamed, retired, saveOutfit, wearIndex, withPiece, withPieces } from '../../wardrobe'
import { Icon } from '../Icon'
import { WARDROBE_TABS, type WardrobeTab } from '../planner/routes'
import type { WardrobeOpen } from '../planner/useNavigation'
import { Clothes } from './Clothes'
import { GarmentSheet, type SheetMode } from './GarmentSheet'
import { OutfitComposer } from './OutfitComposer'
import { WardrobeStats } from './WardrobeStats'

interface Props {
  garments: Garment[]
  outfits: Outfit[]
  wears: Wear[]
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

/**
 * Home → Wardrobe: Outfit (the composer), Clothes (every piece) and Stats,
 * over one wear index worked out per render. It owns the one piece sheet and
 * every write the three make, each with its toast and Undo; nothing here ever
 * rewrites a look or an outfit because a piece changed or went away.
 */
export function Wardrobe({ garments, outfits, wears, onSave, onRemove, onRestore, showToast, open, onOpenConsumed }: Props) {
  const todayKey = localDayKey()
  const [tab, setTab] = useState<WardrobeTab>(() => open?.tab ?? 'outfit')
  const [day, setDay] = useState(() => dayOr(open?.date, todayKey))
  const [sheet, setSheet] = useState<SheetMode | null>(() => sheetFor(open))
  const byId = useMemo(() => liveById(garments), [garments])
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

  /** Log pieces on a day: the day's latest look takes them (unless `another`), else a new look does. */
  const logDay = (d: string, pieces: readonly string[], another = false) => {
    const latest = another ? undefined : lastOf(looksOn(wears, d))
    if (latest) {
      // a piece in Trash stays in the look, so a Restore still finds the day
      const edited = withPieces(latest, [...pieces, ...latest.garmentIds.filter(id => !byId.has(id))])
      onSave(edited)
      showToast('Look updated', () => onSave({ ...latest, updatedAt: newerStamp(edited.updatedAt) }))
      return
    }
    const w = newWear(d, pieces)
    onSave(w)
    showToast(d === todayKey ? 'Logged for today' : `Logged for ${shortDay(d, todayKey)}`, () => onRemove(w.id))
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

  /** An edit of a piece; with a message, Undo writes the copy it was made on back, stamped newer again. */
  const editPiece = (before: Garment, after: Garment, msg?: string) => {
    onSave(after)
    if (msg) showToast(msg, () => onSave({ ...before, updatedAt: newerStamp(after.updatedAt) }))
  }
  const retire = (g: Garment, on: boolean) => editPiece(g, retired(g, on), on ? `Retired ${g.name}` : `${g.name} is back`)
  const removePiece = (g: Garment) => {
    setSheet(null)
    onRemove(g.id)
    showToast(`Deleted ${g.name}`, () => onRestore([g.id]))
  }
  /** The piece sheet's Wear today: into today's latest look, in its own slot, or a look of its own. */
  const wearToday = (g: Garment) => {
    const latest = lastOf(looksOn(wears, todayKey))
    if (!latest) {
      logDay(todayKey, [g.id])
      return
    }
    const edited = withPieces(latest, withPiece(latest.garmentIds, g, byId))
    onSave(edited)
    showToast(`${g.name} added to today’s look`, () => onSave({ ...latest, updatedAt: newerStamp(edited.updatedAt) }))
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
          onWearOutfit={o => logDay(todayKey, o.garmentIds.filter(id => byId.has(id)))}
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
