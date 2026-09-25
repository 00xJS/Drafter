// Which chunk the modules a launch loads go in, so that a deploy renames only
// the files it changed (vite.config.ts hands this to Rolldown's codeSplitting).
//
// A chunk's file name is a hash of its code, and its code names the chunks it
// imports (statically, or by import() — and Vite's preload list names what
// those import in turn). So a chunk is renamed whenever one it names is. The
// entry names the Planner chunk, and the Planner names every lazy view (a
// view's chunk is fetched through import() in planner/lazy.ts): change one
// view and both are renamed. When the views took code they share with the
// launch from the entry and the Planner chunks themselves, as Rolldown puts
// it by default, every view named them, and was renamed with them: 86 of 115
// precached files, 590 KiB gzip, re-downloaded by every installed copy after
// any deploy, whatever it changed.
//
// So what the lazy views share with the launch goes in a stable chunk that
// names no lazy chunk: its modules import only one another and the vendor
// chunks, and import() only one another or a package (the iOS bridge's
// plugins). Its name changes only when its own code does. It is cut in two
// along one line, what the page itself imports (`page`, which loads before
// anything draws) and what only the Planner does (`planner`, which loads after
// sign-in), so the sign-in page does not wait on the planner's share; each
// half is stable, and the Planner's imports the page's, never the other way.
// A module the views share that does name a lazy chunk (the calendar state,
// which import()s the mirrors' engine) gets a small chunk of its own instead,
// so a view that needs it names it and not the Planner. What only the entry
// or only the Planner uses stays in them. A view's own change then renames the
// view, the Planner that names it and the entry that names the Planner.

/**
 * @typedef {{ importedIds: readonly string[], dynamicallyImportedIds: readonly string[], importers: readonly string[], dynamicImporters: readonly string[] }} ModuleLinks
 */

/**
 * @param {(id: string) => ModuleLinks | null} info the module graph, as Rolldown's ChunkingContext reads it
 * @param {{ page: string, planner: string }} roots what a signed-in launch loads first: the page's entry, then the Planner
 * @param {(id: string) => boolean} vendor a package module, which the vendor chunks and the packages' own chunks hold
 * @returns {{ launch: Set<string>, page: Set<string>, planner: Set<string>, hubs: Set<string> }}
 *   `launch`: the roots and everything they import statically; `page` and
 *   `planner`: the stable chunk's two halves; `hubs`: the modules the views
 *   share with the launch that name a lazy chunk, each for a chunk of its own
 */
export function planChunks(info, roots, vendor) {
  const reach = (/** @type {string[]} */ from) => {
    /** @type {Set<string>} */
    const seen = new Set()
    for (const todo = [...from]; todo.length; ) {
      const id = /** @type {string} */ (todo.pop())
      const m = seen.has(id) ? null : info(id)
      if (!m) continue
      seen.add(id)
      todo.push(...m.importedIds)
    }
    return seen
  }
  const onPage = reach([roots.page])
  const launch = reach([roots.page, roots.planner])
  // shared: a launch module something outside the launch imports, statically or by import()
  const shared = [...launch].filter(id => {
    const m = info(id)
    return !!m && !vendor(id) && [...m.importers, ...m.dynamicImporters].some(other => !launch.has(other))
  })
  // Every launch module the shared ones import, then, to a fixpoint, less any
  // that names something outside the set: a static import of a module not in
  // it (bar a package), or an import() of an app module not in it.
  /** @type {Set<string>} */
  const stable = new Set()
  for (const todo = [...shared]; todo.length; ) {
    const id = /** @type {string} */ (todo.pop())
    if (stable.has(id) || vendor(id) || !launch.has(id)) continue
    stable.add(id)
    todo.push(...(info(id)?.importedIds ?? []))
  }
  for (let changed = true; changed; ) {
    changed = false
    for (const id of [...stable]) {
      const m = info(id)
      const names = !m || m.importedIds.some(dep => !vendor(dep) && !stable.has(dep)) || m.dynamicallyImportedIds.some(dep => !vendor(dep) && !stable.has(dep))
      if (names) {
        stable.delete(id)
        changed = true
      }
    }
  }
  // the page's half: what the page reaches of it, which imports nothing of the other half
  const page = new Set([...stable].filter(id => onPage.has(id)))
  const planner = new Set([...stable].filter(id => !onPage.has(id)))
  return { launch, page, planner, hubs: new Set(shared.filter(id => !stable.has(id))) }
}
