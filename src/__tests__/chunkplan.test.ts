import { describe, expect, it } from 'vitest'
import { planChunks, type ModuleLinks } from '../../scripts/lib/chunkplan.mjs'

// Which chunk the launch's modules go in (scripts/lib/chunkplan.mjs, which
// vite.config.ts hands to Rolldown): what the lazy views share with the page
// and the Planner goes in a stable chunk that names no lazy chunk — the page's
// half and the Planner's — and a shared module that does name one gets a
// chunk of its own. On a graph small enough to read.

/** A graph from each module's static and import() edges; importers are worked out. */
function graph(edges: Record<string, { imports?: string[]; dyn?: string[] }>) {
  const links = new Map<string, ModuleLinks & { importers: string[]; dynamicImporters: string[] }>()
  const node = (id: string) => {
    if (!links.has(id)) links.set(id, { importedIds: [], dynamicallyImportedIds: [], importers: [], dynamicImporters: [] })
    return links.get(id)!
  }
  for (const [id, { imports = [], dyn = [] }] of Object.entries(edges)) {
    Object.assign(node(id), { importedIds: imports, dynamicallyImportedIds: dyn })
    for (const dep of imports) node(dep).importers.push(id)
    for (const dep of dyn) node(dep).dynamicImporters.push(id)
  }
  return (id: string) => links.get(id) ?? null
}

const pkg = (id: string) => id.startsWith('npm:')
const sorted = (set: Set<string>) => [...set].sort()

const APP = graph({
  'index.html': { imports: ['main'] },
  main: { imports: ['App', 'utils', 'npm:react'] },
  App: { imports: ['utils'], dyn: ['Planner'] },
  // the page's share: the views use it too, and it import()s only a package (the iOS bridge's plugins)
  utils: { imports: ['native'] },
  native: { dyn: ['npm:plugin'] },
  'npm:plugin': { imports: ['npm:core'] },
  Planner: { imports: ['lazy', 'Today', 'calstate', 'utils'] },
  lazy: { dyn: ['Kitchen', 'Calendar'] },
  Today: { imports: ['kitchenlib', 'calgrid'] },
  // the Planner's share: the views use it, the page never does
  kitchenlib: { imports: ['utils', 'npm:react'] },
  // shared, but it import()s a lazy chunk: a chunk of its own, and so is what imports it
  calstate: { imports: ['utils'], dyn: ['calendars'] },
  calgrid: { imports: ['calstate'] },
  Kitchen: { imports: ['kitchenlib', 'utils', 'calgrid'] },
  Calendar: { imports: ['calstate', 'calgrid', 'utils'] },
  calendars: { imports: ['calstate', 'utils'] },
})

describe('planChunks', () => {
  const plan = planChunks(APP, { page: 'index.html', planner: 'Planner' }, pkg)

  it('reads the launch as the page and the Planner reach it, statically', () => {
    expect(sorted(plan.launch)).toEqual(['App', 'Planner', 'Today', 'calgrid', 'calstate', 'index.html', 'kitchenlib', 'lazy', 'main', 'native', 'npm:react', 'utils'])
  })

  it('puts what the views share with the page in the page’s half, and what only the Planner shares in its half', () => {
    expect(sorted(plan.page)).toEqual(['native', 'utils'])
    expect(sorted(plan.planner)).toEqual(['kitchenlib'])
  })

  it('gives a shared module that names a lazy chunk a chunk of its own, and what imports one likewise', () => {
    expect(sorted(plan.hubs)).toEqual(['calgrid', 'calstate'])
  })

  it('leaves in the entry and the Planner what only they use, the registry of lazy views among it', () => {
    for (const id of ['main', 'App', 'Planner', 'lazy', 'Today']) {
      expect(plan.page.has(id) || plan.planner.has(id) || plan.hubs.has(id), id).toBe(false)
    }
  })

  it('takes a module out of the stable chunk when it imports one that names a lazy chunk', () => {
    const withLink = graph({
      'index.html': { imports: ['main'] },
      main: { imports: ['utils'], dyn: ['Planner'] },
      Planner: { imports: ['utils'], dyn: ['View'] },
      // utils now reaches something that import()s a view
      utils: { imports: ['links'] },
      links: { dyn: ['View'] },
      View: { imports: ['utils'] },
    })
    const p = planChunks(withLink, { page: 'index.html', planner: 'Planner' }, pkg)
    expect(sorted(p.page)).toEqual([])
    expect(sorted(p.hubs)).toEqual(['utils'])
  })
})
