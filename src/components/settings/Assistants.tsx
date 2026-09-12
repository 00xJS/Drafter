import type { SettingsCtx } from './context'
import { AssistantsSection } from '../AssistantsSection'

/**
 * Settings → Assistants: connect Claude (the web and phone apps through the
 * hosted connector, Claude Code and Claude Desktop through a token) to this
 * account, and see or revoke what is connected. It needs an account — in
 * local mode there is no server for an assistant to reach.
 */
export function Assistants({ supabaseOn }: SettingsCtx) {
  if (!supabaseOn) return null
  return <AssistantsSection className="settings-section g-assistants" />
}
