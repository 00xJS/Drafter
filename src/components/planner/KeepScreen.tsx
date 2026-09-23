import type { PlannerCtx } from './ctx'
import { KitchenScreen } from './KitchenScreen'
import { Wardrobe } from './lazy'
import { PeopleScreen } from './PeopleScreen'
import { KEEP_TABS } from './routes'
import { Segmented } from '../stats/Segmented'

/**
 * Keep: the things you keep records about — who you see, where you go, what
 * you eat, what you wear.
 *
 * Before v3.29 these were two tabs (People, which held Places, and Kitchen)
 * and one page hanging off Home (the Wardrobe). Nothing decided that split
 * except the order they were built in: People and the Kitchen grew big enough
 * to claim a tab, and the Wardrobe arrived after the bar was full. They are
 * one kind of thing and they sit together now.
 *
 * Each segment keeps whatever switch it already had — People and Places their
 * List · Stats, the Kitchen its four — so this tab adds one level and changes
 * nothing underneath it.
 */
export function KeepScreen({ p }: { p: PlannerCtx }) {
  const { store, upsert, remove, restore, household, showToast, keepTab, setKeepTab, wardrobeOpen, setWardrobeOpen } = p
  return (
    <>
      <div className="people-tab-seg keep-seg">
        <Segmented items={KEEP_TABS} value={keepTab} onChange={t => setKeepTab(t)} label="Keep view" />
      </div>
      {(keepTab === 'people' || keepTab === 'places') && <PeopleScreen p={p} />}
      {keepTab === 'kitchen' && <KitchenScreen p={p} />}
      {keepTab === 'wardrobe' && (
        <Wardrobe
          garments={store.garments}
          inTrash={store.garmentsInTrash}
          outfits={store.outfits}
          wears={store.wears}
          myId={household.myId}
          // your work days on the calendar: Outfit dresses them for work
          entries={store.events}
          onSave={item => upsert(item)}
          onRemove={id => remove(id)}
          onRestore={ids => restore(ids)}
          showToast={showToast}
          open={wardrobeOpen}
          onOpenConsumed={() => setWardrobeOpen(null)}
        />
      )}
    </>
  )
}
