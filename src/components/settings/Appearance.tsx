import { useState } from 'react'
import { isNative } from '../../native'
import { readThemePref, setThemePref, THEME_LABELS, THEME_PREFS, useTheme, type ThemePref } from '../../theme'

/** Appearance: Light (the default), Dark or Match system. Kept on this device, and applied at once. */
export function Appearance() {
  const [pref, setPref] = useState<ThemePref>(readThemePref)
  const theme = useTheme()
  return (
    <section className="settings-section g-appearance">
      <h3>Appearance</h3>
      <p className="field-hint">Light is the default. Your choice stays on this device, so a phone and a laptop can differ.</p>
      <div className="segmented" role="group" aria-label="Appearance">
        {THEME_PREFS.map(p => (
          <button
            key={p}
            type="button"
            className={pref === p ? 'seg on' : 'seg'}
            aria-pressed={pref === p}
            onClick={() => {
              setThemePref(p)
              setPref(p)
            }}
          >
            {THEME_LABELS[p]}
          </button>
        ))}
      </div>
      {pref === 'system' && (
        <p className="field-hint">
          Following this {isNative() ? 'iPhone' : 'device'}: {theme} right now.
        </p>
      )}
      {isNative() && <p className="field-hint">The launch screen stays light: iOS draws it before Drafter can read this.</p>}
    </section>
  )
}
