import { useEffect, useState } from 'react'
import { CalendarEvent, Habit, MEAL_SLOT_META, WORK_MODE_META } from '../types'
import { eventDayKeys } from '../calendars'
import { isDoneOn, isDueOn } from '../habits'
import { clock, dateKey, fmtTime } from '../utils'
import { CITIES, CITY_REGIONS, Forecast, WeatherCache, cityById, describeCode, disableWeather, getWeather, readCache, requestLocation, setCity } from '../weather'
import { tonightDinner } from './Kitchen'

/** Same 17:00 line Today uses to move the journal card to the evening. */
export function greeting(hour: number, name?: string): string {
  const base = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  // first name only — "Good evening, Joseph", never the full account name;
  // with no name known (local mode, an account without one) it stands alone
  const first = (name ?? '').trim().split(/\s+/)[0]
  return first ? `${base}, ${first}` : base
}

export interface BriefingFacts {
  work?: { label: string; short: string; emoji: string; hours: string }
  events?: { count: number; first?: string }
  habits?: { done: number; due: number }
}

/**
 * The day's facts the strip can state without asking anything: a fact is only
 * present when there is one, so an empty day shows the greeting alone. Work
 * days are a property of the day, not an event, so they are split out of the
 * count exactly as the calendar keeps them off the day's pills.
 */
export function briefingFacts(events: CalendarEvent[], habits: Habit[], now: Date): BriefingFacts {
  const todayKey = dateKey(now)
  const today = events.filter(e => eventDayKeys(e).includes(todayKey))
  const out: BriefingFacts = {}

  const w = today.find(e => e.work)
  if (w?.work) {
    const meta = WORK_MODE_META[w.work]
    out.work = { label: meta.label, short: meta.short, emoji: meta.emoji, hours: w.allDay ? '' : `${clock(w.start)}–${clock(w.end)}` }
  }

  // all-day first, then by start — the same order the calendar draws a day in
  const plain = today.filter(e => !e.work).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start))
  if (plain.length > 0) {
    const firstTimed = plain.find(e => !e.allDay)
    out.events = { count: plain.length, first: firstTimed ? fmtTime(firstTimed.start) : undefined }
  }

  const due = habits.filter(h => isDueOn(h, now))
  if (due.length > 0) out.habits = { done: due.filter(h => isDoneOn(h, todayKey)).length, due: due.length }

  return out
}

/** The picker's value for a cache: off, the device, or a city id. */
export function weatherChoice(cache: WeatherCache): string {
  if (!cache.enabled) return ''
  return cache.city ?? 'location'
}

/**
 * "Your day" in one quiet strip at the top of Today: a greeting, then a tile
 * for each fact that exists — weather, work mode, events, habits, dinner. The
 * date is already in the header above, so it is not repeated here. Weather is
 * opt-in through one picker: Off, the device's location, or a major city —
 * so nobody has to share where they are to see the sky. Nothing is fetched and
 * no permission prompt appears until a choice is made, and the cached forecast
 * seeds the first paint so the tile does not pop in a beat after the rest.
 */
export function BriefingCard({
  events,
  habits,
  dinner,
  now,
  name,
}: {
  events: CalendarEvent[]
  habits: Habit[]
  dinner: ReturnType<typeof tonightDinner>
  now: Date
  /** Who to greet; the first name is used. Absent, the greeting stands alone. */
  name?: string
}) {
  const [cache, setCache] = useState<WeatherCache>(() => readCache())
  // Only an enabled cache seeds the tile: a forecast left under enabled:false
  // would paint a sky the picker says is off, and the effect below would never
  // clear it.
  const [forecast, setForecast] = useState<Forecast | null>(() => (cache.enabled ? (cache.forecast ?? null) : null))

  // Refresh when the strip mounts, when the place changes, and whenever the
  // app comes back to the front; getWeather decides for itself whether that
  // means a network call, so there is no timer and no request while nothing
  // is looking. The coordinates are in the deps so switching from one city to
  // another (enabled stays true) still fetches the new sky.
  useEffect(() => {
    if (!cache.enabled) return
    let live = true
    const refresh = () => {
      void getWeather().then(f => {
        if (live) setForecast(f)
      })
    }
    refresh()
    const hasDoc = typeof document !== 'undefined'
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    if (hasDoc) document.addEventListener('visibilitychange', onVisible)
    return () => {
      live = false
      if (hasDoc) document.removeEventListener('visibilitychange', onVisible)
    }
  }, [cache.enabled, cache.lat, cache.lon])

  // "Use my location" is the only choice that asks the device anything, and
  // the answer can take up to ten seconds. The picker is controlled by the
  // cache, which does not change until then, so without `asking` it would snap
  // back to the old value the moment the prompt opened — the pick would look
  // as though it never took — and a second pick made during the wait would be
  // overwritten by the grant landing after it. So the picker holds "Use my
  // location" and takes no other pick until the prompt settles. Refusing
  // leaves things as they were (a chosen city keeps working; otherwise weather
  // stays off) — but a pick that changes nothing on screen reads as a broken
  // control, so the strip says why until the next attempt.
  const [refused, setRefused] = useState(false)
  const [asking, setAsking] = useState(false)
  const choose = (value: string) => {
    setRefused(false)
    if (value === '') {
      disableWeather()
      setCache(readCache())
      setForecast(null)
      return
    }
    if (value === 'location') {
      setAsking(true)
      void requestLocation().then(pos => {
        setAsking(false)
        setCache(readCache())
        if (pos) setForecast(null)
        else setRefused(true)
      })
      return
    }
    if (setCity(value)) {
      setCache(readCache())
      setForecast(null)
    }
  }

  const facts = briefingFacts(events, habits, now)
  const weather = forecast ? describeCode(forecast.code) : null
  // Named in the tile's title only: the picker above already shows it, and on
  // a 375px phone the sub-line has room for the high, the low and the rain,
  // not for "San Francisco, CA" as well — a third line there makes the weather
  // tile taller than its neighbour and the strip stops being quiet.
  const place = cityById(cache.city)?.name ?? 'Your location'
  const hasTiles = !!(forecast || facts.work || facts.events || facts.habits || dinner)

  return (
    <section className="chart-card briefing" aria-label="Your day">
      <header className="chart-head">
        <div>
          <h3>{greeting(now.getHours(), name)}</h3>
        </div>
        <select
          className="briefing-weather-pick"
          value={asking ? 'location' : weatherChoice(cache)}
          disabled={asking}
          onChange={e => choose(e.target.value)}
          aria-label="Weather for"
          title="Pick a city, or use your location — off forgets both"
        >
          <option value="">Weather off</option>
          <option value="location">Use my location</option>
          {CITY_REGIONS.map(region => (
            <optgroup key={region} label={region}>
              {CITIES.filter(c => c.region === region).map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </header>
      {refused && (
        <p className="briefing-note" role="status">
          {cache.enabled
            ? `Location was refused, so weather still shows ${place}. Allow location for this app in your settings, then try again.`
            : 'Location was refused, so weather stays off. Pick a city instead, or allow location for this app in your settings and try again.'}
        </p>
      )}
      {hasTiles && (
        <ul className="briefing-tiles">
          {forecast && weather && (
            <li className="briefing-tile" title={place}>
              <span className="briefing-glyph" aria-hidden>
                {weather.glyph}
              </span>
              <span className="briefing-text">
                <span className="briefing-main">
                  {forecast.tempC}
                  {forecast.unit} · {weather.label}
                </span>
                <span className="briefing-sub">
                  H {forecast.hiC}° L {forecast.loC}° · {forecast.rainPct}% rain
                </span>
              </span>
            </li>
          )}
          {facts.work && (
            <li className="briefing-tile" title={facts.work.label}>
              <span className="briefing-glyph" aria-hidden>
                {facts.work.emoji}
              </span>
              <span className="briefing-text">
                <span className="briefing-main">{facts.work.label}</span>
                {facts.work.hours && <span className="briefing-sub">{facts.work.hours}</span>}
              </span>
            </li>
          )}
          {facts.events && (
            <li className="briefing-tile">
              <span className="briefing-text">
                <span className="briefing-main">
                  {facts.events.count} event{facts.events.count === 1 ? '' : 's'}
                </span>
                <span className="briefing-sub">{facts.events.first ? `first ${facts.events.first}` : 'all day'}</span>
              </span>
            </li>
          )}
          {facts.habits && (
            <li className="briefing-tile">
              <span className="briefing-text">
                <span className="briefing-main">
                  {facts.habits.done} of {facts.habits.due} habit{facts.habits.due === 1 ? '' : 's'} done
                </span>
                <span className="briefing-sub">{facts.habits.done === facts.habits.due ? 'all ticked' : 'due today'}</span>
              </span>
            </li>
          )}
          {dinner && (
            <li className="briefing-tile">
              <span className="briefing-glyph" aria-hidden>
                {dinner.meal.out ? '🥡' : dinner.recipe?.emoji || '🍽️'}
              </span>
              <span className="briefing-text">
                <span className="briefing-main">{dinner.meal.title}</span>
                <span className="briefing-sub">{dinner.meal.slot === 'dinner' ? 'Tonight' : MEAL_SLOT_META[dinner.meal.slot].label}</span>
              </span>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}
