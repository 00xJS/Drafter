import { useEffect, useState } from 'react'
import { CalendarEvent, Habit, MEAL_SLOT_META, WORK_MODE_META } from '../types'
import { eventDayKeys } from '../calendars'
import { isDoneOn, isDueOn } from '../habits'
import { clock, dateKey, fmtTime } from '../utils'
import { Forecast, WeatherCache, describeCode, disableWeather, getWeather, readCache, requestLocation } from '../weather'
import { tonightDinner } from './Kitchen'

/** Same 17:00 line Today uses to move the journal card to the evening. */
export function greeting(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
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

/**
 * "Your day" in one quiet strip at the top of Today: a greeting, then a tile
 * for each fact that exists — weather, work mode, events, habits, dinner. The
 * date is already in the header above, so it is not repeated here. Weather is
 * opt-in: nothing is fetched and no permission prompt appears until the user
 * taps Enable, and the cached forecast seeds the first paint so the tile does
 * not pop in a beat after the rest.
 */
export function BriefingCard({
  events,
  habits,
  dinner,
  now,
}: {
  events: CalendarEvent[]
  habits: Habit[]
  dinner: ReturnType<typeof tonightDinner>
  now: Date
}) {
  const [cache, setCache] = useState<WeatherCache>(() => readCache())
  const [forecast, setForecast] = useState<Forecast | null>(() => cache.forecast ?? null)

  // Refresh when the strip mounts and whenever the app comes back to the
  // front; getWeather decides for itself whether that means a network call,
  // so there is no timer and no request while nothing is looking.
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
  }, [cache.enabled])

  // Granting flips cache.enabled, and the effect above does the first fetch.
  // Refusing leaves it off — but a tap that changes nothing on screen reads as
  // a broken button, so the strip says why until the next attempt.
  const [refused, setRefused] = useState(false)
  const enable = () => {
    setRefused(false)
    void requestLocation().then(pos => {
      setCache(readCache())
      if (!pos) setRefused(true)
    })
  }
  const off = () => {
    disableWeather()
    setCache(readCache())
    setForecast(null)
  }

  const facts = briefingFacts(events, habits, now)
  const weather = forecast ? describeCode(forecast.code) : null
  const hasTiles = !!(forecast || facts.work || facts.events || facts.habits || dinner)

  return (
    <section className="chart-card briefing" aria-label="Your day">
      <header className="chart-head">
        <div>
          <h3>{greeting(now.getHours())}</h3>
        </div>
        {cache.enabled ? (
          <button type="button" className="btn subtle briefing-weather-btn" onClick={off} aria-label="Turn weather off" title="Forgets your location too">
            Weather off
          </button>
        ) : (
          <button type="button" className="btn subtle briefing-weather-btn" onClick={enable} title="Uses your location for today's forecast">
            Enable weather
          </button>
        )}
      </header>
      {refused && !cache.enabled && (
        <p className="briefing-note" role="status">
          Location was refused, so weather stays off. Allow it for this app in your settings, then try again.
        </p>
      )}
      {hasTiles && (
        <ul className="briefing-tiles">
          {forecast && weather && (
            <li className="briefing-tile">
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
