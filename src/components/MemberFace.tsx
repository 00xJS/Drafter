import { useEffect, useState } from 'react'
import { initials } from '../household'
import { mediaURL, peekMediaURL } from '../media'
import { PROJECT_COLORS } from '../types'

// Who somebody in the household is, in one circle: their picture if they have
// uploaded one (v3.25), and the first two letters of their name if they have
// not. Every surface that draws a member draws it with this — the assignee
// chip on a task, the member list in Settings, the profile card — so a face
// added once shows everywhere at once and there is one fallback to look at.

/**
 * A steady colour for an account with no picture, from its id. The same person
 * is the same colour on every device and in both themes; a name change does
 * not move it, because it is keyed on the id and not on the letters.
 *
 * One of the app's own palette (PROJECT_COLORS), for the same reason a person
 * or a project gets one: these are the user's colours, and --on-user-color is
 * the ink worked out to read on all of them in either theme.
 */
export function faceTint(id: string | undefined): string {
  let n = 0
  for (const ch of id ?? '') n = (n * 31 + ch.charCodeAt(0)) % 9973
  return PROJECT_COLORS[n % PROJECT_COLORS.length]
}

/**
 * The picture, once it has been fetched. Held here rather than in the caller
 * so a list of members makes one request each and the object URL is reused
 * from the media cache on every later paint.
 */
function usePhoto(id: string | null | undefined): string | null {
  const [fetched, setFetched] = useState<{ id: string; url: string | null } | null>(null)
  useEffect(() => {
    if (!id || peekMediaURL(id)) return
    let live = true
    void mediaURL(id).then(url => {
      if (live) setFetched({ id, url })
    })
    return () => {
      live = false
    }
  }, [id])
  if (!id) return null
  return peekMediaURL(id) ?? (fetched?.id === id ? fetched.url : null)
}

export function MemberFace({
  name,
  avatar,
  id,
  size = 28,
  className,
}: {
  name: string
  /** Their picture's media id, or null/absent for the letters. */
  avatar?: string | null
  /** Their account id: what the fallback's colour is keyed on. */
  id?: string
  size?: number
  className?: string
}) {
  const url = usePhoto(avatar)
  const cls = ['member-face', className].filter(Boolean).join(' ')
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) }
  if (url) {
    return <img className={cls} src={url} alt="" style={style} width={size} height={size} />
  }
  return (
    <span className={cls} style={{ ...style, background: faceTint(id ?? name) }} aria-hidden="true">
      {initials(name)}
    </span>
  )
}
