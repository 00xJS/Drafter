/** Where every account's wardrobe photos live: personal/<user id>/. */
export declare const PERSONAL_PREFIX: string
export declare function personalFolder(userId: string): string
/** One of this account's own wardrobe photos: personal/<userId>/<uid>, and nothing else. */
export declare function isPersonalMediaOf(id: unknown, userId: string | null | undefined): boolean

/** A piece's photo fields, as the stores hold them. */
interface PiecePhotos {
  photoId?: unknown
  thumbId?: unknown
  backPhotoId?: unknown
  backThumbId?: unknown
}
/** Every photo one piece points at: its front's photo and thumbnail, then its back's. */
export declare function mediaIdsOf(g: PiecePhotos | null | undefined): string[]
/** Every photo a live piece of clothing, or one in Trash, points at. */
export declare function garmentMediaIds(
  records: readonly ((PiecePhotos & { kind?: unknown; purged?: unknown; deletedAt?: unknown }) | null | undefined)[] | null | undefined,
  opts?: { expiredBefore?: string },
): Set<string>
