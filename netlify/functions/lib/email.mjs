// The morning digest's email, sent through Resend when the host has
// RESEND_API_KEY, and whether it can be sent at all.
//
// Settings asks (GET /api/push answers `emailConfigured`), so the "Also email
// me the morning digest" switch is not offered on a site where nothing would
// ever arrive — it used to be, and a digest that was never sent looked exactly
// like one that was. The hourly run asks too: with no key it sends nothing and
// records nothing, since the switch already says why; with one, a send that
// fails is a failure on the run's record in job_runs.

export const emailConfigured = () => !!process.env.RESEND_API_KEY

/** One plain-text email. True when Resend took it; false without a key, or when it answered with a refusal. */
export async function sendEmail(to, subject, text) {
  if (!emailConfigured()) return false
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.DIGEST_FROM || 'Drafter <onboarding@resend.dev>', to, subject, text }),
  })
  return res.ok
}
