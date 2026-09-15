import { useMemo, useState } from 'react'
import { daysAgo, shortDay } from '../kitchen'
import { countOf, NO_PERSON_FILTER, personMatcher, type PersonFilter, type PersonStats } from '../people'
import {
  COMING_UP_DAYS,
  comingUp,
  daysByMonth,
  daysInMonth,
  getTogethers,
  groupShares,
  mostSeen,
  namesOf,
  neverSeen,
  notSeenLately,
  occasionLine,
  oftenTogether,
  peopleSeen,
  peopleTiles,
  togetherCounts,
  whoByDay,
  yearWithPeople,
  type GroupFilter,
} from '../peoplestats'
import { daysBetween, type DayWindow } from '../stats'
import { useTheme, type Theme } from '../theme'
import { PERSON_GROUPS, PERSON_GROUP_META, type CalendarEntry, type Person, type Task } from '../types'
import { dateKey } from '../utils'
import { PersonFace } from './PersonFace'
import { ChartCard, ListCard, ListRow, MonthBars, MonthCalendar, Narrowed, Podium, RankedBars, StatTile, Stepper, StreakTiles, WindowSwitch, YearTable, markInk } from './stats'

interface Props {
  people: Person[]
  /** Every task, as the list reads them: Mine / Everyone never narrows whom you have seen. */
  tasks: Task[]
  /** Your own calendar entries: one that has happened with people on it counts as seeing them, as on the list. */
  entries?: CalendarEntry[]
  /**
   * The list's group chip and find box, held by the People tab: every figure
   * counts only the people they leave, as the list shows only them.
   */
  filter: PersonFilter
  /** Set them: a chip here is the list's chip, and Show all clears both. */
  onFilter(filter: PersonFilter): void
  /** Saw them: a visit logged now, with Undo, as Today's people nudges log one. */
  onSaw(person: Person): void
  /** Open a person's card on the list. */
  onOpenPerson(person: Person): void
  /** Open a day on the Calendar, its day sheet up. Without it the month's days are only pictures. */
  onOpenDay?(day: string): void
  /**
   * Mine is on in a household. These figures still count everyone's visits,
   * as the list does, but the Calendar a day opens shows only your tasks, so
   * the month says so, as Places → Stats does.
   */
  mineOnCalendar?: boolean
  /** The clock the figures are read from; the tests hand one in. */
  now?: Date
}

const NO_ENTRIES: CalendarEntry[] = []
/** The year table's month heads as the list's table had them, a letter each, so it scrolls less at 375pt. */
const MONTH_LETTERS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']
/** The streak tiles count days with someone, not days logged. */
const STREAK_WORDS = {
  today: 'with someone in a row, today too',
  waiting: 'see someone today to keep it going',
  none: 'see someone to start one',
  best: 'with someone in a row',
}
/** A day of the month calendar shows this many faces, then "+n". */
const FACES_A_DAY = 3
/** The Groups card's longest bar, in percent of its track: short of the kit's 85, so "100%" still fits beside it at 375pt and no bar is squeezed. */
const GROUP_BAR_MAX = 75

/** A person in a list card: their face, name and a line, opening their card, with Saw them at the end. */
function PersonLine({ stats, line, theme, onOpen, onSaw }: { stats: PersonStats; line: string; theme: Theme; onOpen(p: Person): void; onSaw(p: Person): void }) {
  const { person } = stats
  const saw = (button: HTMLElement) => {
    // Seen, they leave this card, and this button with them. A keyboard on it
    // goes on to the next row's Saw them (or the one before), or to the card's
    // heading when it was the last, rather than back to the top of the page.
    // A tap left no focus here, so it moves nothing.
    const held = typeof document !== 'undefined' && document.activeElement === button
    const row = button.closest('li')
    const next = (row?.nextElementSibling ?? row?.previousElementSibling)?.querySelector<HTMLElement>('.btn')
    const head = button.closest('section')?.querySelector<HTMLElement>('h3')
    onSaw(person)
    if (!held) return
    if (next) next.focus({ preventScroll: true })
    else if (head) {
      head.tabIndex = -1
      head.focus({ preventScroll: true })
    }
  }
  return (
    <ListRow
      picture={<PersonFace person={person} theme={theme} className="face-40" />}
      name={person.name}
      line={line}
      onOpen={() => onOpen(person)}
      action={
        <button type="button" className="btn subtle" aria-label={`Saw them: ${person.name}`} onClick={e => saw(e.currentTarget)}>
          Saw them
        </button>
      }
    />
  )
}

/** The list's group chips, with the same counts: every figure below reads the people they leave. Drawn inline, so they sit in Stats' own tree. */
function groupChips(all: readonly PersonStats[], group: GroupFilter, onGroup: (g: GroupFilter) => void) {
  const chip = (g: GroupFilter, label: string, n: number) => (
    <button key={g} type="button" aria-pressed={group === g} className={group === g ? 'seg on' : 'seg'} onClick={() => onGroup(g)}>
      {label} <span className="board-count">{n}</span>
    </button>
  )
  return (
    <div className="people-controls">
      <span className="segmented" role="group" aria-label="Which people">
        {chip('all', 'All', all.length)}
        {PERSON_GROUPS.map(g => chip(g, PERSON_GROUP_META[g], all.filter(s => s.person.group === g).length))}
      </span>
    </div>
  )
}

/**
 * Each group's share of the days you saw any of the people the list shows,
 * over 30 days, 12 months or all time, opening on 30 days as Most seen does.
 * The days sit by the group's name, so the bar ends with the share alone.
 */
function GroupsCard({ shown, seen, now }: { shown: readonly PersonStats[]; seen: readonly Task[]; now: Date }) {
  const [span, setSpan] = useState<DayWindow>(30)
  const { days, groups } = groupShares(shown, seen, span, now)
  return (
    <ChartCard title="Groups" sub="Of the days you saw anyone, the share with each group: a day with family and friends counts for both" aside={<WindowSwitch value={span} onChange={setSpan} />}>
      {days === 0 ? (
        <p className="empty">Log a visit and each group’s share shows here.</p>
      ) : (
        <div className="hbars stats-hbars">
          {groups.map(g => (
            <div key={g.group} className="hbar-row">
              <span className="stats-hbar-label">
                <span className="stats-hbar-name">{PERSON_GROUP_META[g.group]}</span>
                <small className="muted people-group-days">{countOf(g.days, 'day')}</small>
              </span>
              <span className="hbar-track">
                {g.days > 0 && <span className="hbar-fill" style={{ width: `${Math.max(4, g.share * GROUP_BAR_MAX)}%` }} />}
                <span className="hbar-value">{`${Math.round(g.share * 100)}%`}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </ChartCard>
  )
}

/**
 * People → Stats: whom you see, counted in days. The tiles — how many people,
 * the days with someone this month, who was seen lately, who is overdue or
 * due a catch-up, and the streak of days with someone — then the three most
 * seen of all time on a podium, the most seen over 30 days, 12 months or all
 * time, who is past their rhythm (with Saw them), who was never seen, the
 * month with each day's faces, the days seen each month with the year with
 * people beneath, the all-time get-togethers, each group's share, the pairs
 * seen on the same days, and the birthdays and anniversaries coming up.
 * Counted by peoplestats.ts off what the list reads, under the list's group
 * chip and find box, so every figure counts only the people the list shows;
 * while they narrow it, a line under the chips says so, with Show all. Drawn
 * with the Stats kit.
 */
export function PeopleStats({ people, tasks, entries = NO_ENTRIES, filter, onFilter, onSaw, onOpenPerson, onOpenDay, mineOnCalendar = false, now: clock }: Props) {
  const theme = useTheme()
  // read at one instant, and again when the records change, as the list's figures are
  const { now, seen, all } = useMemo(() => {
    const at = clock ?? new Date()
    return { now: at, ...peopleSeen(people, tasks, entries, at) }
  }, [people, tasks, entries, clock])
  const todayKey = dateKey(now)
  const thisYear = now.getFullYear()
  const { group } = filter
  const typed = filter.q.trim()
  const [year, setYear] = useState(thisYear)
  // whom the list shows, by its own rule: every figure below counts them and nobody else
  const shown = useMemo(() => {
    const matches = personMatcher(filter)
    return all.filter(s => matches(s.person))
  }, [all, filter])
  const together = useMemo(() => getTogethers(shown, seen), [shown, seen])
  const byDay = useMemo(() => whoByDay(shown), [shown])

  if (people.length === 0)
    return (
      <div className="people-stats">
        <div className="chart-card">
          <p className="empty">Add the people you want to keep close on the List. Once you have seen them, who you see most, how often and who is due a catch-up show here.</p>
        </div>
      </div>
    )

  const counts = togetherCounts(shown, together)
  const tiles = peopleTiles(shown, together, todayKey)
  const podium = mostSeen(shown, 'all', now, 3)
  const months = daysByMonth(together, year, now)
  const who = group === 'all' ? 'people' : PERSON_GROUP_META[group].toLowerCase()
  const groupsWithPeople = PERSON_GROUPS.filter(g => shown.some(s => s.person.group === g)).length
  // what narrows the figures, as the line heading them and the empty state say it
  const chip = group === 'all' ? '' : PERSON_GROUP_META[group]
  const matching = typed && `matching “${typed}”`
  const narrowedBy = chip || typed ? [`Stats for ${shown.length} of ${people.length} ${people.length === 1 ? 'person' : 'people'}`, chip, matching].filter(Boolean).join(' · ') : ''
  const showAll = () => onFilter(NO_PERSON_FILTER)

  return (
    <div className="people-stats">
      {/* the list's chips: one pressed here is pressed there, and what is typed stays */}
      {groupChips(all, group, g => onFilter({ ...filter, group: g }))}

      {shown.length === 0 ? (
        <Narrowed empty words={typed ? `Nobody matches “${typed}”${chip ? ` in ${chip}` : ''}.` : 'Nobody is in this group yet.'} onShowAll={showAll} />
      ) : (
        <>
          {/* under the chips, heading the figures where the empty state sits, so a chip pressed never moves */}
          {narrowedBy && <Narrowed words={narrowedBy} onShowAll={showAll} />}
          <div className="kpi-row people-tiles">
            {/* on a phone's two columns this one spans its row, so the six below pair up */}
            <StatTile className="kpi-wide" label="People" value={String(tiles.people)} sub={[chip ? `in ${chip}` : 'on your list', matching].filter(Boolean).join(', ')} />
            <StatTile label="This month" value={`${tiles.thisMonth.days} of ${tiles.thisMonth.of}`} sub="days with someone so far" />
            <StatTile label="Seen lately" value={`${tiles.seenLately} of ${tiles.people}`} sub="seen in the last 90 days" />
            <StatTile label="Overdue" value={String(counts.attention.overdue)} sub="past your target rhythm" warn={counts.attention.overdue > 0} />
            {/* the list's "due" badge: Not seen lately below lists these and the overdue together */}
            <StatTile label="Due a catch-up" value={String(counts.attention.due)} sub="past your target rhythm, not yet overdue" />
            <StreakTiles current={tiles.streak.current} best={tiles.streak.best} today={tiles.streak.today} words={STREAK_WORDS} />
          </div>

          {podium.length > 0 && (
            <ChartCard title="Top three" sub="Your most seen of all time, in days">
              <Podium top={podium} picture={r => <PersonFace person={r.person} theme={theme} className="podium-face" />} onOpen={r => onOpenPerson(r.person)} />
            </ChartCard>
          )}

          <RankedBars
            title="Most seen"
            sub="Days seen: two get-togethers on one day count once"
            empty="Log a visit, or finish a task with someone on it, and your most seen show here."
            rank={span => mostSeen(shown, span, now)}
            // a pale colour is moved just far enough to show as a bar on the theme's card
            color={r => r.person.color}
            picture={r => <PersonFace person={r.person} theme={theme} className="face-28" />}
            onOpen={r => onOpenPerson(r.person)}
          />

          <ListCard
            title="Not seen lately"
            sub="Past the rhythm you set for them, or 90 days without one"
            items={notSeenLately(shown)}
            empty="Nobody is past their rhythm."
            row={s => <PersonLine key={s.person.id} stats={s} line={s.reason} theme={theme} onOpen={onOpenPerson} onSaw={onSaw} />}
          />

          <ListCard
            title="Never seen"
            sub="Added two weeks or more ago, and not seen since"
            items={neverSeen(shown, todayKey)}
            empty="Everyone added over two weeks ago has been seen."
            row={s => (
              <PersonLine
                key={s.person.id}
                stats={s}
                line={`Added ${daysAgo(daysBetween(dateKey(s.person.createdAt), todayKey))}`}
                theme={theme}
                onOpen={onOpenPerson}
                onSaw={onSaw}
              />
            )}
          />

          <MonthCalendar
            title="Who you saw"
            today={todayKey}
            // people are the household's, so these are everyone's visits, while the Calendar a day opens follows Mine
            sub={(y, m) => `Each day’s people · ${countOf(daysInMonth(byDay, y, m, todayKey), 'day')} with someone${mineOnCalendar ? ' · counting everyone, though Mine keeps the Calendar to your tasks' : ''}`}
            day={key => {
              const on = key <= todayKey ? byDay.get(key) : undefined
              if (!on) return { what: 'nobody seen' }
              return {
                what: namesOf(on),
                className: 'has-people',
                content: (
                  <span className="people-cal-faces">
                    {on.slice(0, FACES_A_DAY).map(p => (
                      // on the day cell's --surface-2, the ground their ink is worked out for
                      <PersonFace key={p.id} person={p} theme={theme} className="people-cal-face" ground="raised" />
                    ))}
                    {on.length > FACES_A_DAY && (
                      <span className="people-cal-more" aria-hidden="true">
                        +{on.length - FACES_A_DAY}
                      </span>
                    )}
                  </span>
                ),
              }
            }}
            // a day that has come opens on the Calendar, with everything on it
            onOpen={onOpenDay}
          />

          <ChartCard
            className="year-report"
            title={`The year with ${who}`}
            sub="Days seen per month, however many events a day held · trend compares days seen in the last 90 days with the 90 before"
            aside={<Stepper label={String(year)} unit="year" canNext={year < thisYear} onStep={delta => setYear(y => Math.min(thisYear, y + delta))} />}
          >
            <MonthBars
              months={months.months}
              current={year === thisYear ? now.getMonth() : -1}
              label="Days with someone"
              total={`${countOf(months.total, 'day')} with someone in ${year}`}
              trend={months.trend}
            />
            <YearTable
              rows={yearWithPeople(shown, seen, year, now)}
              head="Person"
              noun="day"
              totalHead="Days"
              // each row's dot and cells in their colour as a mark, moved to stand out on the card, as the wardrobe's are
              color={r => markInk(r.person.color, theme)}
              months={MONTH_LETTERS}
              extra={{ head: 'Events', className: 'year-events', cell: r => r.events }}
            />
          </ChartCard>

          <ChartCard
            className="people-all-time"
            title="All time"
            sub="One dinner with three of them is one occasion but three people seen; three get-togethers on one Saturday are three occasions but one day together"
          >
            <div className="kpi-row">
              <StatTile className="kpi-wide" label="Days together" value={String(counts.days)} sub="days you saw any of them, however many get-togethers" />
              <StatTile label="Occasions" value={String(counts.occasions)} sub="get-togethers logged" />
              <StatTile label="People seen" value={String(counts.personVisits)} sub="counted once per person, per occasion" />
            </div>
          </ChartCard>

          {/* a comparison of the groups: on All, once two of them have someone the list shows */}
          {group === 'all' && groupsWithPeople > 1 && <GroupsCard shown={shown} seen={seen} now={now} />}

          <ListCard
            title="Often together"
            sub="The two people you see most on the same day, all time"
            items={oftenTogether(shown)}
            empty="Two people seen on the same day, twice or more, show here."
            row={p => (
              <ListRow
                key={p.key}
                picture={
                  <span className="people-pair">
                    <PersonFace person={p.a} theme={theme} className="face-28" />
                    <PersonFace person={p.b} theme={theme} className="face-28" />
                  </span>
                }
                name={`${p.a.name} and ${p.b.name}`}
                line={`Both seen on ${countOf(p.days, 'day')} · last ${shortDay(p.last, todayKey)}`}
              />
            )}
          />

          <ListCard
            title="Coming up"
            sub={`Birthdays and anniversaries in the next ${COMING_UP_DAYS} days`}
            items={comingUp(shown, now)}
            empty={`No birthdays or anniversaries in the next ${COMING_UP_DAYS} days.`}
            row={o => (
              <ListRow
                key={`${o.person.id}-${o.kind}`}
                picture={<PersonFace person={o.person} theme={theme} className="face-40" />}
                name={o.person.name}
                line={occasionLine(o, todayKey)}
                onOpen={() => onOpenPerson(o.person)}
              />
            )}
          />
        </>
      )}
    </div>
  )
}
