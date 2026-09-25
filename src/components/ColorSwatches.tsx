import { PROJECT_COLORS } from '../types'

/**
 * What each swatch is called, for a screen reader — a hex code is not a
 * colour anybody says — in PROJECT_COLORS' own order (the colours themselves
 * stay in that one data list).
 */
const NAMES = ['Orange', 'Yellow', 'Green', 'Cyan', 'Indigo', 'Pink', 'Red', 'Grey'] as const

/** A swatch colour's name: "Orange". One that is not a swatch is its own code. */
export const colorName = (color: string): string => NAMES[PROJECT_COLORS.indexOf(color)] ?? color

/**
 * The colour row the person, place and project forms share: a swatch for
 * each colour, named by its colour and pressed on the one chosen, where each
 * was a bare hex code to a screen reader, with no word of which was on.
 */
export function ColorSwatches({ value, onChange }: { value: string; onChange(color: string): void }) {
  return (
    <div className="swatches" role="group" aria-label="Color">
      {PROJECT_COLORS.map(c => (
        <button
          key={c}
          type="button"
          className={value === c ? 'swatch on' : 'swatch'}
          style={{ background: c }}
          aria-label={colorName(c)}
          aria-pressed={value === c}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  )
}
