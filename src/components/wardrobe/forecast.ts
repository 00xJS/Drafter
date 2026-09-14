import { useEffect, useState } from 'react'
import { cachedForecast, onWeatherCached, type Forecast } from '../../weather'

/**
 * Today's forecast for the wardrobe's hints: the one the briefing fetched,
 * read from its cache and read again whenever that cache is written. It never
 * asks the network itself, so the hints cost no request of their own; with
 * weather off, or nothing fetched today, it is null and no hint shows.
 */
export function useCachedForecast(): Forecast | null {
  const [forecast, setForecast] = useState<Forecast | null>(() => cachedForecast())
  useEffect(() => onWeatherCached(() => setForecast(cachedForecast())), [])
  return forecast
}
