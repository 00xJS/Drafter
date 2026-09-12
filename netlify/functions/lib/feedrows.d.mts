// Types for the pure helpers src/ imports in tests. The runtime is feedrows.mjs;
// this exists only so tsc (which checks src/) does not see an implicit any.

/** The row as the app would see it: the stored data plus its owner. */
export declare function withOwner<T>(item: T, userId: string | null | undefined): T & { ownerId?: string }

/** Headers for a service-key read, and the Supabase URL it goes to. */
export declare function serviceHeaders(): { apikey: string | undefined; authorization: string }
export declare function baseUrl(): string | undefined

/** The feed rows for one reader: only their own tasks, projects and entries. */
export declare function feedFor(
  items: unknown[],
  site: string,
  tz: string | undefined,
  myId: string,
): { uid: string; title: string; start: number; end?: number; allDay: boolean; date?: string; transparent?: boolean }[]
