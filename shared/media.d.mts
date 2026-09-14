/** Where every account's wardrobe photos live: personal/<user id>/. */
export declare const PERSONAL_PREFIX: string
export declare function personalFolder(userId: string): string
/** One of this account's own wardrobe photos: personal/<userId>/<uid>, and nothing else. */
export declare function isPersonalMediaOf(id: unknown, userId: string | null | undefined): boolean
/** Every photo a live piece of clothing, or one in Trash, points at. */
export declare function garmentMediaIds(
  records: readonly ({ kind?: unknown; purged?: unknown; deletedAt?: unknown; photoId?: unknown; thumbId?: unknown } | null | undefined)[] | null | undefined,
  opts?: { expiredBefore?: string },
): Set<string>
