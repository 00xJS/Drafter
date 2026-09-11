interface Props {
  /** false when the deploy has no backend configured — the sign-in path is hidden. */
  configured: boolean
  onSignIn?: () => void
}

const FEATURES: { icon: string; title: string; text: string }[] = [
  { icon: '☀️', title: 'Home', text: 'A briefing for the day — greeting, weather if you want it, work hours, what is due — then habits to tick, routines to run and tonight’s dinner. The week’s review and your journal are a segment away.' },
  { icon: '🗂', title: 'Tasks', text: 'Wishlist → to do → doing → done, as a list, a board, the month’s bills or a project’s notes. Due dates, priorities, checklists and a comment trail on everything.' },
  { icon: '📅', title: 'Calendar', text: 'Month, week and timeline: tasks, events, meals, home or office days and your Google, Outlook or iCloud calendars in one grid.' },
  { icon: '👥', title: 'People & places', text: 'Who you saw and where you went — a rhythm for each, so Home says when it has been a while.' },
  { icon: '🍳', title: 'Kitchen', text: 'Recipes, a week of meals cooked or eaten out, and a grocery list built from what is planned.' },
  { icon: '⌘', title: 'Command palette', text: 'Cmd/Ctrl+K jumps to any view, creates a task, project or bill, searches everything, and captures a line straight to the Inbox.' },
  { icon: '✨', title: 'AI assist', text: 'Draft a plan from a goal, break a task into steps, suggest tags, and write the week’s review from what actually happened.' },
  { icon: '🤖', title: 'Agent-ready', text: 'An MCP server lets your AI agents create tasks, log visits, plan meals and add to the journal through the same rules the app runs.' },
]

export function Landing({ configured, onSignIn }: Props) {
  return (
    <div className="landing">
      <header className="landing-header">
        <div className="brand">
          <span className="brand-mark">✈</span>
          <span>Drafter</span>
        </div>
        {configured && (
          <button className="btn primary" onClick={onSignIn}>
            Sign in
          </button>
        )}
      </header>

      <section className="landing-hero">
        <h1>
          Run your life like a <span className="hero-accent">well-run project.</span>
        </h1>
        <p>
          Drafter is a home journal and planner — five tabs on desktop and phone: Home, Tasks, Calendar, People and
          Kitchen — with habits, routines, a weekly review, GitHub links and an iPhone app that feels like one.
        </p>
        {configured ? (
          <button className="btn primary landing-cta" onClick={onSignIn}>
            Sign in to your planner
          </button>
        ) : (
          <p className="landing-note">
            This deployment isn’t connected to a backend yet, so sign-in and storage are disabled. Site owner: set{' '}
            <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> and redeploy.
          </p>
        )}
      </section>

      <section className="feature-grid">
        {FEATURES.map(f => (
          <article key={f.title} className="feature-card">
            <span className="feature-icon">{f.icon}</span>
            <h3>{f.title}</h3>
            <p>{f.text}</p>
          </article>
        ))}
      </section>

      <footer className="landing-footer">
        Private beta — accounts are provisioned by the site owner. Your plans stay yours.
      </footer>
    </div>
  )
}
