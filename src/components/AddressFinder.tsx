import { useState } from 'react'
import { AddressCandidate, LookupArea, LookupError, findAddress, lookupArea, lookupQuery, readTypedArea, writeTypedArea } from '../geocode'
import type { Place } from '../types'

// Find address: a place's name looked up on OpenStreetMap through Drafter's
// server, and the candidates offered to pick from. Nothing is saved here: the
// place editor fills its fields with the pick for its Save, while a place's
// card and the setup sheet's Find missing addresses save each pick at once.

/** How a lookup is made: the real one, or a test's. */
export type Lookup = (q: string, area: LookupArea | null) => Promise<{ candidates: AddressCandidate[]; area?: { lat: number; lon: number } }>

/**
 * Where to look, for the finder: the area findAddress leans to, and when none
 * is known a town typed here, kept on this device (with its point once the
 * server has looked it up) so it is asked for once.
 */
export function useLookup(places: readonly Place[], lookup: Lookup = findAddress) {
  const [typed, setTyped] = useState(() => readTypedArea()?.text ?? '')
  // null until there is somewhere to lean to: then the town field shows, and
  // stays while it is typed into, until the first lookup keeps the town
  const area = lookupArea(places)
  const canRun = !!area || !!typed.trim()
  const run = async (q: string) => {
    const where = area ?? (typed.trim() ? { typed: typed.trim(), from: 'typed' as const, label: `near ${typed.trim()}` } : null)
    if (!area && typed.trim()) writeTypedArea({ text: typed.trim() })
    const res = await lookup(q, where)
    // the server looked the town up: keep its point, so it is not looked up again
    if (res.area && where && 'typed' in where) writeTypedArea({ text: where.typed, ...res.area })
    return res.candidates
  }
  return { area, typed, setTyped, canRun, run }
}

/** Asked once, when there is nothing else to lean a lookup to: which town the places are in. */
export function TownField({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <label className="field address-town">
      <span>Which town are your places in?</span>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder="e.g. Phoenix, AZ" autoComplete="address-level2" enterKeyHint="search" />
      <small className="field-hint">Kept on this device, and sent with each lookup so the addresses found are near you.</small>
    </label>
  )
}

/** The candidates, each a button: its name if it has one, and its address. */
export function CandidateList({ candidates, onPick, label }: { candidates: AddressCandidate[]; onPick(c: AddressCandidate): void; label: string }) {
  return (
    <ul className="address-candidates" aria-label={label}>
      {candidates.map(c => (
        <li key={`${c.lat},${c.lon},${c.address}`}>
          <button type="button" className="address-candidate" onClick={() => onPick(c)}>
            {c.name && <strong>{c.name}</strong>}
            <span>{c.address}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** A lookup's failure in words; anything unexpected says so plainly. */
export const lookupMessage = (e: unknown) => (e instanceof LookupError ? e.message : 'The lookup did not go through. Try again in a moment.')

/**
 * Find address, in the place editor and on a place's card: looks up the name
 * (and the address as far as it is typed) and hands the pick to `onPick` —
 * for the address and pin "Pin this spot" and I'm here use.
 */
export function FindAddress({
  name,
  address,
  places,
  onPick,
  saves = false,
  lookup,
}: {
  name: string
  address: string
  places: readonly Place[]
  onPick(c: AddressCandidate): void
  /** A pick is saved at once (a place's card), rather than filling an editor's fields for its Save. */
  saves?: boolean
  lookup?: Lookup
}) {
  const { area, typed, setTyped, canRun, run } = useLookup(places, lookup)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [found, setFound] = useState<AddressCandidate[] | null>(null)
  const [error, setError] = useState('')
  const q = lookupQuery(name, address)
  const go = async () => {
    setOpen(true)
    if (!canRun) return
    setBusy(true)
    setError('')
    setFound(null)
    try {
      setFound(await run(q))
    } catch (e) {
      setError(lookupMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="find-address">
      <button type="button" className="btn" disabled={!q || busy} onClick={() => void go()} title="Look the address up on OpenStreetMap">
        {busy ? 'Looking…' : 'Find address'}
      </button>
      {open && (
        <div className="find-address-panel">
          {!area && !found && (
            <>
              <TownField value={typed} onChange={setTyped} />
              <button type="button" className="btn primary" disabled={!typed.trim() || busy} onClick={() => void go()}>
                Look up {name.trim() || 'the place'}
              </button>
            </>
          )}
          {error && <p className="warn">{error}</p>}
          {found && found.length === 0 && (
            <p className="field-hint">
              OpenStreetMap has nothing called that {area ? area.label : 'anywhere'}. {saves ? 'Type the address in from Edit.' : 'Try the name as it is signed, or type the street.'}
            </p>
          )}
          {found && found.length > 0 && (
            <>
              <p className="field-hint">
                From OpenStreetMap, {area ? area.label : `near ${typed.trim()}`}. {saves ? 'Pick one to save it, with a pin.' : 'Pick one to fill in the address and pin.'}
              </p>
              <CandidateList
                candidates={found}
                label={`Addresses for ${name.trim() || 'this place'}`}
                onPick={c => {
                  onPick(c)
                  setOpen(false)
                  setFound(null)
                }}
              />
            </>
          )}
          {(found || error) && (
            <button type="button" className="btn subtle" onClick={() => setOpen(false)}>
              {found?.length ? 'None of these' : 'Close'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
