import { useEffect, useState } from 'react'
import { APP_VERSION } from '../../appversion'
import { isNative } from '../../native'

/** Capacitor's App plugin, fetched on a phone only: out here, as the React Compiler cannot compile a component with an import() in it. */
const loadApp = () => import('@capacitor/app')

/**
 * Data → About: which build this is. On a phone every install used to say
 * "1.0"; the marketing version (1.0.1, 1.1.0) and Apple's build number now
 * sit here so a TestFlight or Xcode install can be told apart.
 */
export function About() {
  const [build, setBuild] = useState<string | null>(null)
  const [version, setVersion] = useState(APP_VERSION)

  useEffect(() => {
    if (!isNative()) return
    void loadApp().then(({ App }) =>
      App.getInfo().then(info => {
        if (info.version) setVersion(info.version)
        if (info.build) setBuild(info.build)
      }),
    )
  }, [])

  return (
    <section className="settings-section g-data">
      <h3>About</h3>
      <p>
        Drafter {version}
        {build ? ` (${build})` : ''}
      </p>
      <p className="field-hint">
        {build
          ? 'The first number is the release — 1.0.1 a small drop, 1.1.0 a feature. The one in parentheses is this install’s build; it goes up every time the app is put on a phone.'
          : 'The web build of Drafter.'}
      </p>
    </section>
  )
}
