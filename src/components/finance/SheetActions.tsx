import { ConfirmButton } from '../ConfirmButton'

/**
 * The foot of a bill's or a payday's short sheet: the full editor for what the
 * sheet leaves out, Archive (it stops counting and is kept) or Unarchive, and
 * Delete, which goes to the Trash with an Undo like any task's.
 */
export function SheetActions({ archived, onMore, onArchive, onDelete }: { archived: boolean; onMore(): void; onArchive(): void; onDelete(): void }) {
  return (
    <div className="fin-sheet-actions">
      <button type="button" className="btn subtle fin-more" onClick={onMore}>
        More options…
      </button>
      <span className="spacer" />
      <button type="button" className="btn subtle" onClick={onArchive}>
        {archived ? 'Unarchive' : 'Archive'}
      </button>
      <ConfirmButton className="btn subtle danger" confirmLabel="Tap again to delete" onConfirm={onDelete}>
        Delete
      </ConfirmButton>
    </div>
  )
}
