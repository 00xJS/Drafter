import type { PlannerCtx } from './ctx'
import { PushedScreen } from './PushedScreen'

/**
 * Admin, as a screen you go into.
 *
 * It is the owner's, it is rare, and it was the last thing in the app still
 * sliding up over a page — the same sheet Settings and the chat left. It is
 * built like Settings (a nav of sections over one long body), so it takes the
 * same frame and the same stylesheet, and the section buttons stopped
 * floating over the text here for the same reason they did there.
 */
export function AdminScreen({ p }: { p: PlannerCtx }) {
  const { Admin } = p.views
  const { setPushed, adminGroup } = p
  return (
    <PushedScreen title="Admin" onBack={() => setPushed(null)}>
      <Admin initialGroup={adminGroup} />
    </PushedScreen>
  )
}
