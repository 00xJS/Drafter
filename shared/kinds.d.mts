/** The sync_posts allowlist: every kind the server stores. */
export declare const SYNC_KINDS: ReadonlySet<string>
/** Kinds only their owner may read, even inside a household. */
export declare const PERSONAL_KINDS: ReadonlySet<string>
export declare function kindOf(data: Record<string, unknown> | null | undefined): string
export declare function readableKind(kind: string | null | undefined, ownerId: string | null | undefined, readerId: string | null | undefined): boolean
