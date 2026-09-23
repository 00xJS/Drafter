import { useEffect, useState } from 'react'
import { apiFetch } from './api'
import { rememberMediaLinks } from './media'
import { getSupabase, storedUserId } from './supabase'

// Households: people who share this planner. Membership lives server-side;
// the client only needs the member list (for assignees) and who "me" is.

export interface Member {
  id: string
  email: string
  displayName: string
  /**
   * The id of their picture in the media bucket, or null (v3.25). A bare id,
   * never under personal/: the picture exists to be seen by the other member,
   * on a task you handed them.
   */
  avatar?: string | null
  /**
   * A short-lived link to that picture, signed by /api/household: the storage
   * policy lets a housemate read a photo only through a record, and a picture
   * is in none. Absent from a server that predates it.
   */
  avatarLink?: { url: string; expiresAt: string } | null
  role: string
  joinedAt: string
}

export interface HouseholdInvite {
  householdId: string
  name: string
}

export interface HouseholdInfo {
  me: { id: string; email: string; displayName: string | null; avatar?: string | null }
  household: { id: string; name: string; created_by: string | null } | null
  members: Member[]
  /** Invitations waiting for me to accept. Joining is never automatic. */
  invites?: HouseholdInvite[]
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok || !body) throw new Error(body?.error ?? `HTTP ${res.status}`)
  return body
}

export function householdAction<T = HouseholdInfo>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  return apiFetch('/api/household', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...payload }) }).then(json<T>)
}

const CACHE_KEY = 'drafter:household'

/** The member list this device kept from the last answer, or null. */
function cachedInfo(): HouseholdInfo | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as HouseholdInfo) : null
  } catch {
    return null
  }
}

/** The links to the members' pictures, for the media cache to fetch them through (src/media.ts). */
export const pictureLinks = (info: HouseholdInfo | null): { id: string; url: string; expiresAt: string }[] =>
  (info?.members ?? []).flatMap(m => (m.avatar && m.avatarLink?.url ? [{ id: m.avatar, url: m.avatarLink.url, expiresAt: m.avatarLink.expiresAt }] : []))

/** Member list + my id, cached so assignee chips render offline. */
export function useHousehold(): { info: HouseholdInfo | null; myId: string | null; refresh(): Promise<void>; error?: string } {
  const [info, setInfo] = useState<HouseholdInfo | null>(cachedInfo)
  // offline with an expired token, getSession below answers nothing for a while (and then nothing at all):
  // the planner opens at once under the account whose session this device holds
  const [myId, setMyId] = useState<string | null>(() => info?.me.id ?? storedUserId())
  const [error, setError] = useState<string | undefined>(undefined)

  /** The server's answer, kept and cached for the next launch offline; or why there is none. */
  const read = (): Promise<void> =>
    householdAction('status').then(
      next => {
        rememberMediaLinks(pictureLinks(next))
        setInfo(next)
        setMyId(next.me.id)
        setError(undefined)
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(next))
        } catch {
          /* ignore */
        }
      },
      (e: Error) => setError(e.message),
    )
  const refresh = async () => {
    if (getSupabase()) await read()
  }

  useEffect(() => {
    const sb = getSupabase()
    if (!sb) return
    // the links the last answer carried, while they last: a relaunch draws the pictures before the next answer
    rememberMediaLinks(pictureLinks(cachedInfo()))
    sb.auth.getSession().then(({ data }) => {
      if (data.session) setMyId(data.session.user.id)
    })
    void read()
  }, [])

  return { info, myId, refresh, error }
}

export const memberName = (info: HouseholdInfo | null, id: string | undefined): string | null => nameAmong(info?.members ?? [], id)

/** The same, from a list of members: an editor is handed the list, not the household. */
export const nameAmong = (members: readonly Pick<Member, 'id' | 'displayName'>[], id: string | undefined): string | null => {
  if (!id) return null
  const m = members.find(x => x.id === id)
  return m ? m.displayName : null
}

export const initials = (name: string): string =>
  name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(s => s[0]!.toUpperCase())
    .join('')
