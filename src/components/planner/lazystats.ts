import { preloadable, withSheet } from '../../lazyload'

// The four areas that keep Stats of their own — People, Places, the Kitchen
// and the Wardrobe — each in a chunk of its own, drawn by its area and by the
// Stats lens. They sit in this small registry rather than planner/lazy.ts,
// which names every lazy chunk: the Kitchen and the lens import these, and a
// view that imported lazy.ts was renamed with it on every deploy (the hash
// cascade, scripts/lib/chunkplan.mjs). lazy.ts re-exports them for the
// warm-up and the shell.

// People → People's Stats and People → Places' Stats, behind each segment's
// List · Stats switch, each with the counting only it reads (peoplestats.ts,
// placestats.ts) in a chunk of its own
export const PeopleStats = preloadable(() => withSheet(import('../PeopleStats'), import('../../styles/views/people-stats.css')).then(m => m.PeopleStats), 'PeopleStats')
export const PlacesStats = preloadable(() => import('../PlacesStats').then(m => m.PlacesStats), 'PlacesStats')
// Kitchen → Stats and the Stats kit it draws with: a chunk of its own, which
// the Kitchen imports from here and a finger on the Kitchen tab warms too
export const KitchenStats = preloadable(() => withSheet(import('../kitchen/KitchenStats'), import('../../styles/views/kitchen-stats.css')).then(m => m.KitchenStats), 'KitchenStats')
// …and the wardrobe's figures on their own, because the Stats lens draws them
// too and must not drag the composer, the clothes grid and the photo pipeline
// in behind them. Wardrobe.tsx still imports the view directly, so the two
// share one chunk rather than shipping it twice.
export const WardrobeStats = preloadable(() => import('../wardrobe/WardrobeStats').then(m => m.WardrobeStats), 'WardrobeStats')
