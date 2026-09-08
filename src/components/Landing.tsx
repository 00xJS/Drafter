interface Props {
  /** false when the deploy has no backend configured — the sign-in path is hidden. */
  configured: boolean
  onSignIn?: () => void
}

const FEATURES: { icon: string; title: string; text: string }[] = [
  { icon: '🗂', title: 'Projects & tasks', text: 'Wishlist → to do → doing → done. Due dates, priorities, checklists and a comment trail on everything.' },
  { icon: '🛣', title: 'Roadmap', text: 'Projects and milestones on a timeline, so the kitchen refresh and the side app both have an end in sight.' },
  { icon: '☀️', title: 'Today', text: 'Overdue, due today, this week, blocked — the one page to open every morning.' },
  { icon: '🐙', title: 'GitHub-linked', text: 'Paste an issue, PR, repo or Projects URL onto a task and see its live state without leaving the plan.' },
  { icon: '✨', title: 'AI assist', text: 'Break a task into steps, suggest tags, clarify or expand a description.' },
  { icon: '🤖', title: 'Agent-ready', text: 'An MCP server and REST gateway let your AI agents create tasks, comment, and close things out.' },
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
          Drafter is a personal project manager — projects, tasks with due dates, a roadmap and a daily view — with
          GitHub links and a kitchen planner built in.
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
