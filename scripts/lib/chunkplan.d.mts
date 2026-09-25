/** A module's links in the graph, as Rolldown's ChunkingContext reads them. */
export interface ModuleLinks {
  importedIds: readonly string[]
  dynamicallyImportedIds: readonly string[]
  importers: readonly string[]
  dynamicImporters: readonly string[]
}

/** Where the launch's modules go: the stable chunk's two halves (`page`, `planner`), a chunk of its own each (`hubs`), or the entry or Planner chunk they came in. */
export declare function planChunks(
  info: (id: string) => ModuleLinks | null,
  roots: { page: string; planner: string },
  vendor: (id: string) => boolean,
): { launch: Set<string>; page: Set<string>; planner: Set<string>; hubs: Set<string> }
