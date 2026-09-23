import { saveMedia } from './media'
import { preparePicture } from './photo'

// A task's or a note's picture, saved as the app keeps one. Loaded with the
// task editor and the notes pad, never at launch: the photo pipeline stays
// out of the first load (lazyload.test.ts), as it is for the wardrobe.

/** A picture's file name once it is a JPEG: "IMG_1234.HEIC" is "IMG_1234.jpg". */
export const jpegName = (name: string): string => `${name.replace(/\.[^./]*$/, '') || 'picture'}.jpg`

/**
 * A picture for a task or a note, saved at most PICTURE_EDGE on its longest
 * side, redrawn once on this device (preparePicture), with its small copy
 * kept in the same entry for the task editor's squares (mediaThumbURL). It
 * used to be saved as picked, the camera's 2–5 MB, and stored, uploaded and
 * decoded whole by every device that drew it. A picture this browser cannot
 * read (a HEIC in desktop Chrome) is kept as it came, as before. Returns the
 * id, as saveMedia does.
 */
export async function savePicture(file: File): Promise<string> {
  const ready = await preparePicture(file).catch(() => null)
  if (!ready) return saveMedia(file)
  const picture = ready.picture === file ? file : new File([ready.picture], jpegName(file.name), { type: ready.picture.type })
  return saveMedia(picture, { thumb: ready.thumb ?? undefined })
}
