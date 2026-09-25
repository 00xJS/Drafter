import { useMemo, useSyncExternalStore } from 'react'
import { onWeatherCached, parseWeather, skyPhrase, storedWeather, todaysForecast } from '../../weather'

const follow = (changed: () => void) => onWeatherCached(changed)
const nothingOnTheServer = () => ''

/**
 * Today's sky for Home's greeting — "84° and sunny" — or null: weather off,
 * or nothing fetched for today yet. It fetches nothing. The "Your day" card
 * further down owns the weather: its picker is the on/off choice and its
 * watcher does the fetching, and every write it makes to the cache (a new
 * forecast, another place, weather off) is followed here as it is made.
 * `noonMs` is a moment on today and `hour` the hour now, both from Home's own
 * clock.
 */
export function useTodaysSky(noonMs: number, hour: number): string | null {
  const raw = useSyncExternalStore(follow, storedWeather, nothingOnTheServer)
  return useMemo(() => {
    const forecast = todaysForecast(parseWeather(raw), noonMs)
    return forecast ? skyPhrase(forecast, hour) : null
  }, [raw, noonMs, hour])
}
