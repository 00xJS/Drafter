import { Dispatch, SetStateAction, useEffect, useState } from 'react'
import { CalendarFeedInfo, feedAction, fetchFeedInfo } from '../../calendars'
import { useAsyncAction } from './useAsyncAction'

export interface FeedInfo {
  feed: CalendarFeedInfo | null
  setFeed: Dispatch<SetStateAction<CalendarFeedInfo | null>>
  feedError: string
  feedBusy: boolean
  runFeed(action: 'enable' | 'rotate' | 'disable'): Promise<boolean>
}

/**
 * The calendar feed's status, which also carries the email-in address: asked
 * for once each time Settings opens, and shared by the Calendars and Email in
 * sections.
 */
export function useFeedInfo(): FeedInfo {
  const [feed, setFeed] = useState<CalendarFeedInfo | null>(null)
  const { busy: feedBusy, error: feedError, run, setError: setFeedError } = useAsyncAction()
  useEffect(() => {
    fetchFeedInfo()
      .then(setFeed)
      .catch(e => setFeedError((e as Error).message))
  }, [setFeedError])
  const runFeed = (action: 'enable' | 'rotate' | 'disable') => run(async () => setFeed(await feedAction(action)))
  return { feed, setFeed, feedError, feedBusy, runFeed }
}
