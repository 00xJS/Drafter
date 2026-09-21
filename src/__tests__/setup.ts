// What every test run starts from, whatever machine it is on.
//
// The build host is not a clean room. Netlify's build environment carries the
// site's real environment variables — including BACKUP_PASSPHRASE, which the
// owner set on 2026-09-21 — so a test that reads `process.env` directly passes
// on a laptop and on GitHub Actions, and fails on the one machine that
// actually ships the site. That is exactly what happened: `backupEncryptionOn`
// answered true where a test expected false, and runBackup wrote an encrypted
// envelope where a test from before encryption expected a plain snapshot.
//
// So the environment a test sees is decided HERE, not inherited. A test that
// wants a variable sets it itself and puts it back afterwards; everything else
// can rely on it being absent.

/**
 * Variables that change what the code under test does, cleared before anything
 * runs. Add one here rather than leaving a test to hope the host is clean.
 */
const DECIDED_HERE = ['BACKUP_PASSPHRASE']

for (const key of DECIDED_HERE) delete process.env[key]
