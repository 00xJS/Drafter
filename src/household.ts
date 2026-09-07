import { useEffect, useState } from 'react'
import { apiFetch } from './api'
import { getSupabase } from './supabase'

// Households: people who share this planner. Membership lives server-side;
// the client only needs the member list (for assignees) and who "me" is.

export interface Member {
  id: string
  email: string
  displayName: string
  role: string
  joinedAt: string
}

export interface HouseholdInvite {
  householdId: string
  name: string
}

export interface HouseholdInfo {
  me: { id: string; email: string; displayName: string | null }
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

/** Member list + my id, cached so assignee chips render offline. */
export function useHousehold(): { info: HouseholdInfo | null; myId: string | null; refresh(): Promise<void>; error?: string } {
  const [info, setInfo] = useState<HouseholdInfo | null>(() => {
    try {
      const raw = localStorage.getItem(CACHE_KEY)
      return raw ? (JSON.parse(raw) as HouseholdInfo) : null
    } catch {
      return null
    }
  })
  const [myId, setMyId] = useState<string | null>(info?.me.id ?? null)
  const [error, setError] = useState<string | undefined>(undefined)

  const refresh = async () => {
    const sb = getSupabase()
    if (!sb) return
    try {
      const next = await householdAction('status')
      setInfo(next)
      setMyId(next.me.id)
      setError(undefined)
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    const sb = getSupabase()
    if (!sb) return
    sb.auth.getSession().then(({ data }) => {
      if (data.session) setMyId(data.session.user.id)
    })
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { info, myId, refresh, error }
}

export const memberName = (info: HouseholdInfo | null, id: string | undefined): string | null => {
  if (!id) return null
  const m = info?.members.find(x => x.id === id)
  return m ? m.displayName : null
}

export const initials = (name: string): string =>
  name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(s => s[0]!.toUpperCase())
    .join('')
