interface Props {
  /** false when the deploy has no backend configured — the sign-in path is hidden. */
  configured: boolean
  onSignIn?: () => void
}

const FEATURES: { icon: string; title: string; text: string }[] = [
  { icon: '📋', title: 'Kanban pipeline', text: 'Idea → draft → scheduled → posted, with a canceled lane for the ones that didn’t make it.' },
  { icon: '🗓', title: 'Content calendar', text: 'See the month at a glance, click a day to schedule, drag to reschedule.' },
  { icon: '📈', title: 'Insights', text: 'Engagement by platform, best time to post, what performs by tag — with a table view for every chart.' },
  { icon: '📦', title: 'Own your history', text: 'Import your full X and Instagram archives — free official exports, no platform APIs required.' },
  { icon: '✨', title: 'AI assist', text: 'Platform-native variants, tag suggestions, and an analysis of what your best posts have in common.' },
  { icon: '🤖', title: 'Automation-ready', text: 'A clean REST backend lets your bots draft, schedule, and log results around the clock.' },
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
          Plan it. Draft it. <span className="hero-accent">Ship it.</span>
        </h1>
        <p>
          Drafter is a personal command center for social posting — a kanban board, calendar, and analytics for
          everything you publish on X, Instagram, and beyond.
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
        Private beta — accounts are provisioned by the site owner. Your drafts stay yours.
      </footer>
    </div>
  )
}
