import { useEffect } from 'react'
import type { PlannerCtx } from './ctx'
import { PushedScreen } from './PushedScreen'

/**
 * Settings, as a screen you go into.
 *
 * Eight sections of prose, switches and connected accounts is not a glance,
 * and a sheet made that plain: the sections had a third of a phone to scroll
 * in, and the buttons that pick between them floated over the text going past
 * underneath. The screen's own header holds them still.
 */
export function SettingsScreen({ p }: { p: PlannerCtx }) {
  const { Settings } = p.views
  const { store, calendars, googlePush, microsoftSync, household, isOwner, setPushed, setAdminOpen, settingsNonce, settingsGroup, setSettingsGroup } = p
  // the group an opener asked for is for that visit: Settings opened any other way starts where it always has
  useEffect(() => () => setSettingsGroup(undefined), [setSettingsGroup])
  return (
    <PushedScreen title="Settings" onBack={() => setPushed(null)}>
      <Settings
        // bumped when a calendar consent flow returns, so the sections refetch
        key={settingsNonce}
        initialGroup={settingsGroup}
        store={store}
        calendars={calendars}
        googlePush={googlePush}
        microsoftSync={microsoftSync}
        household={household}
        // the back button is the way out; this is for signing out, which leaves on your behalf
        onClose={() => setPushed(null)}
        onOpenAdmin={
          isOwner
            ? () => {
                setPushed(null)
                setAdminOpen(true)
              }
            : undefined
        }
      />
    </PushedScreen>
  )
}
